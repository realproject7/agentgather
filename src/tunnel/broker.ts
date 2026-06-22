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

export interface BrokerOptions {
  /** Time source in epoch milliseconds. Injectable for deterministic tests. */
  now?: () => number;
  /** Milliseconds a route stays active after registration or a heartbeat. */
  routeTtlMs?: number;
}

const DEFAULT_ROUTE_TTL_MS = 30_000;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * In-memory tunnel broker. One active route per slug; routes expire after a TTL
 * unless refreshed by a heartbeat, and can be closed explicitly by the host.
 */
export class TunnelBroker {
  private readonly now: () => number;
  private readonly routeTtlMs: number;
  private readonly routes = new Map<string, RouteMetadata>();

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
    return { ...route };
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

/**
 * Create a local HTTP listener for simulated remote participants. The first
 * path segment is the route slug. Active slugs return route status; unknown,
 * expired, or closed slugs return a stable tunnel error. The listener never
 * forwards to a host room server in this ticket.
 */
export function createBrokerHttpServer(broker: TunnelBroker): Server {
  return createServer((req, res) => {
    handleParticipantRequest(broker, req, res);
  });
}

function handleParticipantRequest(
  broker: TunnelBroker,
  req: IncomingMessage,
  res: ServerResponse
): void {
  try {
    const url = new URL(req.url ?? "/", "http://broker.local");
    const slug = url.pathname.split("/").filter(Boolean)[0];
    if (slug === undefined) {
      throw new TunnelError("unsupported_route", 404, "request path does not name a route");
    }
    const route = broker.resolve(slug);
    sendJson(res, 200, { ok: true, route_slug: route.route_slug, status: route.status });
  } catch (error) {
    if (error instanceof TunnelError) {
      sendJson(res, error.status, error.body());
      return;
    }
    sendJson(res, 500, { ok: false, error: "internal_error", message: "internal tunnel error" });
  }
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
