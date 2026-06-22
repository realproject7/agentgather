// Local tunnel protocol for managed telegent.dev routing.
//
// This module defines the wire shapes exchanged between a host tunnel client,
// the routing broker, and remote participants. It is transport-agnostic and
// local-only: later tickets (#35 host client, #36 forwarding core) implement
// real forwarding against these types. Nothing here opens a public network
// connection or requires credentials.

/** Lifecycle state of a registered route. */
export type RouteStatus = "active" | "expired" | "closed";

/**
 * Stable, machine-readable tunnel error codes. Treat these as a permanent
 * contract: never rename or repurpose a code, only add new ones.
 */
export type TunnelErrorCode =
  | "invalid_registration"
  | "route_slug_taken"
  | "invalid_heartbeat"
  | "route_not_found"
  | "route_expired"
  | "route_closed"
  | "unsupported_route"
  | "internal_error";

/**
 * Ephemeral route metadata. This is the only per-route state the broker keeps.
 * It deliberately excludes room messages, Room Brief bodies, participant
 * tokens, request bodies, and response bodies.
 */
export interface RouteMetadata {
  route_slug: string;
  route_id: string;
  host_connection_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  status: RouteStatus;
}

/** Host -> broker: request to register a route for a room slug. */
export interface HostRegistration {
  route_slug: string;
}

/** Broker -> host: route registered, including broker-minted identifiers. */
export interface RouteRegistered {
  ok: true;
  route: RouteMetadata;
}

/** Host -> broker: keep an existing route alive. */
export interface RouteHeartbeat {
  route_id: string;
  host_connection_id: string;
}

/** Broker -> host: heartbeat accepted, with refreshed metadata. */
export interface HeartbeatAccepted {
  ok: true;
  route: RouteMetadata;
}

/** Host -> broker: close a route. */
export interface RouteCloseRequest {
  route_id: string;
  host_connection_id: string;
}

/** Broker -> host: route closed. */
export interface RouteCloseResult {
  ok: true;
  route_slug: string;
  status: "closed";
}

/**
 * Remote participant request forwarded by the broker to the host room server.
 * Defined for later forwarding tickets; the broker never persists any field of
 * this envelope.
 */
export interface ForwardedRequest {
  route_slug: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Opaque, base64-encoded body. Forwarded in flight, never stored. */
  body_base64?: string;
}

/**
 * Host room server response carried back through the broker. As with the
 * request envelope, the broker forwards but never stores the body.
 */
export interface ForwardedResponse {
  status: number;
  headers: Record<string, string>;
  /** Opaque, base64-encoded body. Forwarded in flight, never stored. */
  body_base64?: string;
}

/** Structured tunnel error payload with a stable code and a generic message. */
export interface TunnelErrorBody {
  ok: false;
  error: TunnelErrorCode;
  message: string;
}

/**
 * Error raised by broker operations. Carries a stable code and the HTTP status
 * the participant listener should return. Messages are intentionally generic so
 * they never leak raw request URLs or tokens.
 */
export class TunnelError extends Error {
  readonly code: TunnelErrorCode;
  readonly status: number;

  constructor(code: TunnelErrorCode, status: number, message: string) {
    super(message);
    this.name = "TunnelError";
    this.code = code;
    this.status = status;
  }

  body(): TunnelErrorBody {
    return { ok: false, error: this.code, message: this.message };
  }
}

/** Header names stripped before any tunnel-layer logging or metrics. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization"
]);

/**
 * Remove credential-bearing headers from a forwarded header map so tunnel logs
 * and metrics can never capture participant tokens. Pure; returns a new map and
 * does not mutate the input.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(name.toLowerCase())) continue;
    safe[name] = value;
  }
  return safe;
}
