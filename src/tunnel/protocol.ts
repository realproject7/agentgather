// Local tunnel protocol for managed agentgather.dev routing.
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
  | "route_request_limit"
  | "wait_limit"
  | "rate_limited"
  | "request_too_large"
  | "response_too_large"
  | "host_unavailable"
  | "unknown_request"
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
  // Last time the host tunnel client proved presence by a heartbeat or a relay
  // poll. Used to detect a host that exited without closing its route.
  last_heartbeat_at: string;
  expires_at: string;
  status: RouteStatus;
  // Derived on read: the route is active and the host has signalled presence
  // within the grace window. A registered slug with no attending host reports
  // host_connected: false so participants and re-registration see the truth.
  host_connected: boolean;
}

/** Host -> broker: request to register a route for a room slug. */
export interface HostRegistration {
  route_slug: string;
  // Local room server URL the broker forwards participant requests to. This is
  // routing configuration, not room data; the broker stores no room messages,
  // briefs, tokens, or bodies.
  target?: string;
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
 * Remote participant request the broker holds in flight for the host tunnel
 * client to claim. The broker keeps this in memory only until the matching
 * response arrives; it never persists any field.
 */
export interface ForwardedRequest {
  request_id: string;
  route_slug: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Opaque, base64-encoded body. Held in flight, never stored. */
  body_base64?: string;
}

/**
 * Host room server response the host posts back for a request id. As with the
 * request envelope, the broker forwards but never stores the body.
 */
export interface ForwardedResponse {
  status: number;
  headers: Record<string, string>;
  /** Opaque, base64-encoded body. Held in flight, never stored. */
  body_base64?: string;
}

/** Host -> broker: claim the next pending participant request for a route. */
export interface RelayPollRequest {
  route_id: string;
  host_connection_id: string;
}

/** Broker -> host: the claimed request, or null when none are pending. */
export interface RelayClaim {
  ok: true;
  request: ForwardedRequest | null;
}

/** Host -> broker: the response for exactly one in-flight request id. */
export interface RelayRespondRequest {
  route_id: string;
  host_connection_id: string;
  request_id: string;
  response: ForwardedResponse;
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
