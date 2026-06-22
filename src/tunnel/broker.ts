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
  type HostRegistration,
  type RouteCloseRequest,
  type RouteCloseResult,
  type RouteHeartbeat,
  type RouteMetadata,
  TunnelError
} from "./protocol.js";
import { forwardToHost } from "./forwarding.js";

export interface BrokerOptions {
  /** Time source in epoch milliseconds. Injectable for deterministic tests. */
  now?: () => number;
  /** Milliseconds a route stays active after registration or a heartbeat. */
  routeTtlMs?: number;
}

const DEFAULT_ROUTE_TTL_MS = 30_000;
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
  private readonly routes = new Map<string, RouteMetadata>();
  // Local room server URL per slug, used to forward participant requests. This
  // is routing configuration, not stored room data.
  private readonly targets = new Map<string, string>();

  constructor(options: BrokerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.routeTtlMs = options.routeTtlMs ?? DEFAULT_ROUTE_TTL_MS;
  }

  /** Register a route for a slug. Rejects a duplicate active slug. */
  register(registration: HostRegistration): RouteMetadata {
    const slug = registration.route_slug;
    if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
      throw new TunnelError("invalid_registration", 400, "route slug is missing or malformed");
    }
    if (registration.target !== undefined) assertLocalTarget(registration.target);
    const existing = this.currentRoute(slug);
    if (existing && existing.status === "active") {
      throw new TunnelError("route_slug_taken", 409, "an active route already exists for this slug");
    }
    const nowMs = this.now();
    const route: RouteMetadata = {
      route_slug: slug,
      route_id: mintId("rte"),
      host_connection_id: mintId("conn"),
      created_at: isoFrom(nowMs),
      last_seen_at: isoFrom(nowMs),
      expires_at: isoFrom(nowMs + this.routeTtlMs),
      status: "active"
    };
    this.routes.set(slug, route);
    // Always re-sync the target so a re-registration without a target cannot
    // inherit a previous route's forwarding host.
    if (registration.target !== undefined) {
      this.targets.set(slug, registration.target);
    } else {
      this.targets.delete(slug);
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
    return { ...route };
  }

  /** Close a route. Idempotent identifiers must match the registered route. */
  closeRoute(request: RouteCloseRequest): RouteCloseResult {
    const route = this.findByConnection(request.route_id, request.host_connection_id);
    route.status = "closed";
    this.targets.delete(route.route_slug);
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

  private currentRoute(slug: string): RouteMetadata | undefined {
    const route = this.routes.get(slug);
    return route ? this.refresh(route) : undefined;
  }

  private refresh(route: RouteMetadata): RouteMetadata {
    if (route.status === "active" && Date.parse(route.expires_at) <= this.now()) {
      route.status = "expired";
    }
    return route;
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
const MAX_HOST_BODY_BYTES = 16_000;

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
    sendJson(res, 200, { ok: true, route_slug: route.route_slug, status: route.status });
    return;
  }
  const target = broker.target(slug);
  if (target === undefined) {
    throw new TunnelError("route_not_found", 502, "route has no forwarding target");
  }
  const forwardPath = url.pathname.slice(`/${slug}`.length) || "/";
  await forwardToHost({ target, path: `${forwardPath}${url.search}`, req, res });
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
  const body = await readJsonBody(req);
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
  throw new TunnelError("unsupported_route", 404, "unknown host control action");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.length;
    if (total > MAX_HOST_BODY_BYTES) {
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
