// Local tunnel broker harness.
//
// The broker registers a single host route per slug and exposes a local HTTP
// listener that resolves participant requests to route status. It does not
// forward real room endpoints yet (that is ticket #36) and never opens a public
// network connection. The only state it keeps is ephemeral RouteMetadata.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import {
  type ForwardedRequest,
  type ForwardedResponse,
  type HostRegistration,
  type RouteCloseRequest,
  type RouteCloseResult,
  type RouteHeartbeat,
  type RouteMetadata,
  TunnelError
} from "./protocol.js";
import { forwardToHost } from "./forwarding.js";
import { BROKER_LIMITS, BrokerGuards, type BrokerLimits } from "./limits.js";
import { BrokerLogger, type BrokerLogSink, classifyPath, routeHash } from "./logging.js";
import { RelayHub } from "./relay.js";

export interface BrokerOptions {
  /** Time source in epoch milliseconds. Injectable for deterministic tests. */
  now?: () => number;
  /** Idle timeout: ms a route stays active after registration or activity. */
  routeTtlMs?: number;
  /** Hard cap on total route lifetime regardless of activity. */
  maxRouteLifetimeMs?: number;
  /** Override prototype resource limits (used by tests). */
  limits?: Partial<BrokerLimits>;
  /** Structured, redaction-safe log sink. Defaults to stderr JSON lines. */
  logSink?: BrokerLogSink;
  /** Relay: max ms a request waits unclaimed before the host is unavailable. */
  claimTimeoutMs?: number;
  /** Relay: max ms after a claim before the host response times out. */
  responseTimeoutMs?: number;
  /**
   * Grace window after the host's last heartbeat/poll before the route is
   * treated as host-disconnected (reclaimable, and forwards fast-fail).
   */
  hostGraceMs?: number;
  /**
   * Optional usage meter for public (managed relay) routing. Local-target
   * routes are never metered. The broker depends only on this callback shape
   * (dependency inversion): the platform metering layer provides the concrete
   * implementation and injects it here, so the broker never imports it.
   */
  meter?: BrokerMeter;
}

/**
 * Public-routing usage hooks invoked by the broker's relay lifecycle and admit
 * paths. Every method is optional and may be sync or async. `admitPublicForward`
 * throws a TunnelError (e.g. quota_exceeded) to deny a forward before it runs.
 * Local-target (direct) routing never calls these.
 */
export interface BrokerMeter {
  onPublicRouteRegistered?(slug: string): void | Promise<void>;
  onPublicRouteClosed?(slug: string, durationMs: number): void | Promise<void>;
  admitPublicForward?(slug: string): void | Promise<void>;
  onPublicForward?(slug: string, path: string, bytesIn: number, bytesOut: number): void | Promise<void>;
}

const DEFAULT_CLAIM_TIMEOUT_MS = 10_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 35_000;
const DEFAULT_HOST_GRACE_MS = 30_000;

const DEFAULT_ROUTE_TTL_MS = BROKER_LIMITS.idleTimeoutMs;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_TARGET_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Validate a forwarding target before the broker will store and fetch it. This
 * ticket is local-only, so the target must be a loopback http(s) URL. Rejecting
 * non-local hosts blocks server-side request forgery to internal-network or
 * cloud-metadata addresses through the unauthenticated register endpoint.
 * Authenticated host registration and egress allowlists for non-local targets
 * are deferred to the #37 hardening ticket.
 */
function assertLocalTarget(target: string): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new TunnelError("invalid_registration", 400, "target is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TunnelError("invalid_registration", 400, "target must use http or https");
  }
  if (!LOCAL_TARGET_HOSTS.has(url.hostname)) {
    throw new TunnelError("invalid_registration", 400, "target must be a local address");
  }
}

/**
 * In-memory tunnel broker. One active route per slug; routes expire after a TTL
 * unless refreshed by a heartbeat, and can be closed explicitly by the host.
 */
export class TunnelBroker {
  private readonly now: () => number;
  private readonly routeTtlMs: number;
  private readonly maxRouteLifetimeMs: number;
  private readonly hostGraceMs: number;
  private readonly limits: BrokerLimits;
  private readonly guards: BrokerGuards;
  private readonly logger: BrokerLogger;
  private readonly relay: RelayHub;
  private readonly routes = new Map<string, RouteMetadata>();
  // Optional local room server URL per slug for direct-fetch mode (local tests).
  // Managed relay mode registers no target and never stores one.
  private readonly targets = new Map<string, string>();
  private readonly meter: BrokerMeter | undefined;

  constructor(options: BrokerOptions = {}) {
    this.meter = options.meter;
    this.now = options.now ?? (() => Date.now());
    this.limits = { ...BROKER_LIMITS, ...options.limits };
    this.routeTtlMs = options.routeTtlMs ?? this.limits.idleTimeoutMs;
    this.maxRouteLifetimeMs = options.maxRouteLifetimeMs ?? this.limits.maxRouteLifetimeMs;
    this.hostGraceMs = options.hostGraceMs ?? DEFAULT_HOST_GRACE_MS;
    this.guards = new BrokerGuards(this.now, this.limits);
    this.logger = new BrokerLogger(options.logSink);
    this.relay = new RelayHub(
      {
        claimTimeoutMs: options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS,
        responseTimeoutMs: options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
        responseBodyBytes: this.limits.responseBodyBytes
      },
      () => mintId("req")
    );
  }

  /** Register a route for a slug. Rejects a duplicate active slug. */
  register(registration: HostRegistration): RouteMetadata {
    const slug = registration.route_slug;
    if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
      throw new TunnelError("invalid_registration", 400, "route slug is missing or malformed");
    }
    if (registration.target !== undefined) assertLocalTarget(registration.target);
    const existing = this.currentRoute(slug);
    // Only a genuinely active, host-connected route blocks the slug. A stale
    // route whose host stopped heartbeating/polling is reclaimable, so the
    // original host (or a new session) can recover the same slug.
    if (existing && existing.status === "active" && existing.host_connected) {
      throw new TunnelError("route_slug_taken", 409, "an active host already holds this slug");
    }
    if (existing) this.relay.closeRoute(slug);
    const nowMs = this.now();
    const route: RouteMetadata = {
      route_slug: slug,
      route_id: mintId("rte"),
      host_connection_id: mintId("conn"),
      created_at: isoFrom(nowMs),
      last_seen_at: isoFrom(nowMs),
      last_heartbeat_at: isoFrom(nowMs),
      expires_at: isoFrom(nowMs + this.routeTtlMs),
      status: "active",
      host_connected: true
    };
    this.routes.set(slug, route);
    // Always re-sync the target so a re-registration without a target cannot
    // inherit a previous route's forwarding host.
    if (registration.target !== undefined) {
      this.targets.set(slug, registration.target);
    } else {
      this.targets.delete(slug);
      // Public (managed relay) route: meter its activation. register() is
      // synchronous, so this lifecycle gauge is best-effort; a failure is
      // surfaced on the structured log (not silently swallowed) rather than
      // failing registration. The enforcement-critical forward/admit path is
      // fully awaited instead.
      if (this.meter?.onPublicRouteRegistered !== undefined) {
        const hook = this.meter.onPublicRouteRegistered.bind(this.meter);
        void (async () => hook(slug))().catch((error) =>
          this.logger.log({ event: "metering_error", route_hash: routeHash(slug), error: errorCode(error) })
        );
      }
    }
    return { ...route };
  }

  /** Local room server URL a slug forwards to, if one was registered. */
  target(slug: string): string | undefined {
    return this.targets.get(slug);
  }

  /** Refresh an active route's last-seen and expiry timestamps. */
  heartbeat(beat: RouteHeartbeat): RouteMetadata {
    if (typeof beat.route_id !== "string" || typeof beat.host_connection_id !== "string") {
      throw new TunnelError("invalid_heartbeat", 400, "heartbeat is missing route identifiers");
    }
    const route = this.findByConnection(beat.route_id, beat.host_connection_id);
    if (route.status === "closed") {
      throw new TunnelError("route_closed", 410, "this route has been closed");
    }
    if (route.status === "expired") {
      throw new TunnelError("route_expired", 410, "this route has expired");
    }
    const nowMs = this.now();
    route.last_seen_at = isoFrom(nowMs);
    route.expires_at = isoFrom(nowMs + this.routeTtlMs);
    this.markHostSeen(route);
    return { ...this.refresh(route) };
  }

  /** Close a route. Idempotent identifiers must match the registered route. */
  closeRoute(request: RouteCloseRequest): RouteCloseResult {
    const route = this.findByConnection(request.route_id, request.host_connection_id);
    const wasPublic = !this.targets.has(route.route_slug);
    route.status = "closed";
    this.targets.delete(route.route_slug);
    this.relay.closeRoute(route.route_slug);
    // Meter the public route's lifetime. closeRoute() is synchronous, so this is
    // best-effort; a failure is surfaced on the structured log rather than
    // silently dropped.
    if (wasPublic && this.meter?.onPublicRouteClosed !== undefined) {
      const durationMs = Math.max(0, this.now() - Date.parse(route.created_at));
      const slug = route.route_slug;
      const hook = this.meter.onPublicRouteClosed.bind(this.meter);
      void (async () => hook(slug, durationMs))().catch((error) =>
        this.logger.log({ event: "metering_error", route_hash: routeHash(slug), error: errorCode(error) })
      );
    }
    return { ok: true, route_slug: route.route_slug, status: "closed" };
  }

  /**
   * Resolve a participant-facing slug to its active route, or throw a stable
   * tunnel error. Returns a copy so callers cannot mutate stored metadata.
   */
  resolve(slug: string): RouteMetadata {
    const route = this.currentRoute(slug);
    if (!route) {
      throw new TunnelError("route_not_found", 404, "no route is registered for this slug");
    }
    if (route.status === "closed") {
      throw new TunnelError("route_closed", 410, "this route has been closed");
    }
    if (route.status === "expired") {
      throw new TunnelError("route_expired", 410, "this route has expired");
    }
    return { ...route };
  }

  /** Copy of all stored route metadata, with lazy expiry applied. */
  snapshot(): RouteMetadata[] {
    return [...this.routes.values()].map((route) => ({ ...this.refresh(route) }));
  }

  /** Host claims the next pending relay request for its route, or null. */
  claimRelay(routeId: string, hostConnectionId: string): ForwardedRequest | null {
    const route = this.findByConnection(routeId, hostConnectionId);
    if (route.status !== "active") {
      throw new TunnelError(route.status === "closed" ? "route_closed" : "route_expired", 410, "route is not active");
    }
    // A poll proves the host is attending, so it refreshes presence and the
    // idle timer.
    this.markHostSeen(route);
    this.touch(route.route_slug);
    return this.relay.claim(route.route_slug);
  }

  /** Host posts the response for exactly one in-flight relay request id. */
  respondRelay(routeId: string, hostConnectionId: string, requestId: string, response: ForwardedResponse): void {
    this.findByConnection(routeId, hostConnectionId);
    this.relay.respond(requestId, response);
  }

  /**
   * Forward a participant request under `/<slug>/`, applying concurrency and
   * rate guards and emitting a redaction-safe access log. A route registered
   * with a local target is fetched directly (local tests); otherwise the
   * request is held for the host tunnel client to claim and answer. The caller
   * must have resolved the slug as an active route first.
   */
  async forward(slug: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const forwardPath = url.pathname.slice(`/${slug}`.length) || "/";
    const pathClass = classifyPath(forwardPath);
    const isWait = pathClass === "wait";
    const method = req.method ?? "GET";
    const startedAt = this.now();

    let release: () => void;
    try {
      release = this.guards.enter({
        routeSlug: slug,
        clientIp: req.socket.remoteAddress ?? "unknown",
        isWait,
        authenticated: typeof req.headers.authorization === "string"
      });
    } catch (error) {
      this.logger.log({ event: "limit_rejected", route_hash: routeHash(slug), method, path_class: pathClass, error: errorCode(error) });
      throw error;
    }

    this.touch(slug);
    try {
      const target = this.targets.get(slug);
      let result: { status: number; bytesIn: number; bytesOut: number };
      if (target !== undefined) {
        // Local-target (direct) routing is never metered.
        result = await this.forwardDirect(target, forwardPath, url, req, res);
      } else {
        // Public relay routing: admit against the quota before forwarding (this
        // may throw quota_exceeded), then meter the completed forward's bytes.
        if (this.meter?.admitPublicForward !== undefined) await this.meter.admitPublicForward(slug);
        result = await this.forwardViaRelay(slug, forwardPath, url, req, res);
        if (this.meter?.onPublicForward !== undefined) {
          await this.meter.onPublicForward(slug, forwardPath, result.bytesIn, result.bytesOut);
        }
      }
      this.logger.log({
        event: "forward",
        route_hash: routeHash(slug),
        method,
        path_class: pathClass,
        status: result.status,
        duration_ms: this.now() - startedAt,
        bytes_in: result.bytesIn,
        bytes_out: result.bytesOut,
        ...(isWait ? { wait_held_ms: this.now() - startedAt } : {})
      });
    } catch (error) {
      this.logger.log({ event: "forward_error", route_hash: routeHash(slug), method, path_class: pathClass, error: errorCode(error) });
      throw error;
    } finally {
      release();
    }
  }

  private async forwardDirect(
    target: string,
    forwardPath: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<{ status: number; bytesIn: number; bytesOut: number }> {
    return forwardToHost({
      target,
      path: `${forwardPath}${url.search}`,
      req,
      res,
      requestBodyBytes: this.limits.requestBodyBytes,
      responseBodyBytes: this.limits.responseBodyBytes
    });
  }

  private async forwardViaRelay(
    slug: string,
    forwardPath: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<{ status: number; bytesIn: number; bytesOut: number }> {
    // Fail fast when the host tunnel has disconnected rather than queueing a
    // request that can only time out.
    const route = this.currentRoute(slug);
    if (route === undefined || !route.host_connected) {
      throw new TunnelError("host_unavailable", 504, "host tunnel is not attending this route");
    }
    const body = await readBody(req, this.limits.requestBodyBytes);
    const response = await this.relay.enqueue(slug, {
      route_slug: slug,
      method: req.method ?? "GET",
      path: `${forwardPath}${url.search}`,
      headers: selectEnvelopeHeaders(req),
      ...(body !== undefined ? { body_base64: body.toString("base64") } : {})
    });
    const responseBody =
      typeof response.body_base64 === "string" ? Buffer.from(response.body_base64, "base64") : Buffer.alloc(0);
    const responseHeaders: Record<string, string> = {};
    const contentType = response.headers["content-type"] ?? response.headers["Content-Type"];
    if (typeof contentType === "string") responseHeaders["content-type"] = contentType;
    res.writeHead(response.status, responseHeaders);
    res.end(responseBody);
    return { status: response.status, bytesIn: body?.length ?? 0, bytesOut: responseBody.length };
  }

  private touch(slug: string): void {
    const route = this.routes.get(slug);
    if (route && route.status === "active") {
      const nowMs = this.now();
      route.last_seen_at = isoFrom(nowMs);
      route.expires_at = isoFrom(nowMs + this.routeTtlMs);
    }
  }

  private currentRoute(slug: string): RouteMetadata | undefined {
    const route = this.routes.get(slug);
    return route ? this.refresh(route) : undefined;
  }

  private refresh(route: RouteMetadata): RouteMetadata {
    const nowMs = this.now();
    if (route.status === "active") {
      const idleExpired = Date.parse(route.expires_at) <= nowMs;
      const lifetimeExceeded = Date.parse(route.created_at) + this.maxRouteLifetimeMs <= nowMs;
      if (idleExpired || lifetimeExceeded) route.status = "expired";
    }
    // host_connected is always recomputed so it never goes stale in storage.
    route.host_connected =
      route.status === "active" && nowMs - Date.parse(route.last_heartbeat_at) <= this.hostGraceMs;
    return route;
  }

  private markHostSeen(route: RouteMetadata): void {
    route.last_heartbeat_at = isoFrom(this.now());
  }

  private findByConnection(routeId: string, connectionId: string): RouteMetadata {
    for (const route of this.routes.values()) {
      if (route.route_id === routeId && route.host_connection_id === connectionId) {
        return this.refresh(route);
      }
    }
    throw new TunnelError("route_not_found", 404, "no route matches these identifiers");
  }
}

// Reserved path prefix for host control requests. The slug pattern forbids the
// underscore, so this prefix can never collide with a participant route slug.
const HOST_PREFIX = "_host";
const MAX_HOST_CONTROL_BODY_BYTES = 16_000;
const MAX_HOST_RESPOND_BODY_BYTES = Math.ceil((BROKER_LIMITS.responseBodyBytes * 4) / 3) + 16_000;

/**
 * Create a local HTTP listener for the broker. Host control requests use the
 * reserved `/_host/<action>` prefix (register, heartbeat, close); every other
 * path is treated as a participant request whose first segment is the route
 * slug. Active slugs return route status; unknown, expired, or closed slugs
 * return a stable tunnel error. The listener never forwards to a host room
 * server in this ticket (forwarding lands with #36).
 */
export function createBrokerHttpServer(broker: TunnelBroker): Server {
  return createServer((req, res) => {
    void routeBrokerRequest(broker, req, res);
  });
}

async function routeBrokerRequest(
  broker: TunnelBroker,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://broker.local");
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === HOST_PREFIX) {
      await handleHostRequest(broker, segments[1], req, res);
      return;
    }
    await handleParticipantRequest(broker, url, req, res);
  } catch (error) {
    sendTunnelError(res, error);
  }
}

async function handleParticipantRequest(
  broker: TunnelBroker,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const slug = url.pathname.split("/").filter(Boolean)[0];
  if (slug === undefined) {
    throw new TunnelError("unsupported_route", 404, "request path does not name a route");
  }
  const route = broker.resolve(slug);
  // A bare `/<slug>` with no trailing slash is a route-status probe; anything
  // under `/<slug>/` is forwarded to the host room server.
  if (url.pathname === `/${slug}`) {
    sendJson(res, 200, {
      ok: true,
      route_slug: route.route_slug,
      status: route.status,
      host_connected: route.host_connected
    });
    return;
  }
  await broker.forward(slug, url, req, res);
}

async function handleHostRequest(
  broker: TunnelBroker,
  action: string | undefined,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== "POST") {
    throw new TunnelError("unsupported_route", 405, "host control requires POST");
  }
  const body = await readJsonBody(req, action === "respond" ? MAX_HOST_RESPOND_BODY_BYTES : MAX_HOST_CONTROL_BODY_BYTES);
  if (action === "register") {
    const route = broker.register({
      route_slug: body.route_slug as string,
      ...(typeof body.target === "string" ? { target: body.target } : {})
    });
    sendJson(res, 200, { ok: true, route });
    return;
  }
  if (action === "heartbeat") {
    const route = broker.heartbeat({
      route_id: body.route_id as string,
      host_connection_id: body.host_connection_id as string
    });
    sendJson(res, 200, { ok: true, route });
    return;
  }
  if (action === "close") {
    const result = broker.closeRoute({
      route_id: body.route_id as string,
      host_connection_id: body.host_connection_id as string
    });
    sendJson(res, 200, result);
    return;
  }
  if (action === "poll") {
    const request = broker.claimRelay(body.route_id as string, body.host_connection_id as string);
    sendJson(res, 200, { ok: true, request });
    return;
  }
  if (action === "respond") {
    broker.respondRelay(
      body.route_id as string,
      body.host_connection_id as string,
      body.request_id as string,
      body.response as ForwardedResponse
    );
    sendJson(res, 200, { ok: true });
    return;
  }
  throw new TunnelError("unsupported_route", 404, "unknown host control action");
}

async function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.length;
    if (total > limitBytes) {
      throw new TunnelError("invalid_registration", 413, "host control body is too large");
    }
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sendTunnelError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof TunnelError) {
    sendJson(res, error.status, error.body());
    return;
  }
  sendJson(res, 500, { ok: false, error: "internal_error", message: "internal tunnel error" });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

function isoFrom(ms: number): string {
  return new Date(ms).toISOString();
}

function errorCode(error: unknown): string {
  return error instanceof TunnelError ? error.code : "internal_error";
}

const ENVELOPE_HEADERS = new Set(["authorization", "content-type", "accept", "origin", "referer"]);

function selectEnvelopeHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (ENVELOPE_HEADERS.has(lower)) headers[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

async function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer | undefined> {
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.length;
    if (total > limitBytes) {
      throw new TunnelError("request_too_large", 413, "request body exceeds the broker limit");
    }
    chunks.push(buffer);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}
