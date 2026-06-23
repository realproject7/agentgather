// Platform room status and route health bridge.
//
// A pure derivation from signals the system already produces — the broker's
// route metadata (lifecycle status + host_connected, which already folds in
// heartbeat freshness and the grace window) and the host /status attendance
// signal — into the central PlatformRoomStatus from #80, plus a human-facing
// reason. There is deliberately no parallel heartbeat or health tracker here,
// and the derivation never inspects message bodies, counts, or briefs.

import type { ParticipantKind } from "../protocol/index.js";
import type { RouteMetadata, RouteStatus } from "../tunnel/index.js";
import type { PlatformRoomStatus, PlatformStatusReason, RouteHealth } from "./types.js";

/**
 * Route-side signal. `registered` means the broker holds a route for the slug;
 * `host_connected` means the host is actually attending the relay (the endpoint
 * is reachable), which is distinct from merely being registered.
 */
export interface RouteHealthSignal {
  registered: boolean;
  route_status?: RouteStatus;
  host_connected?: boolean;
}

/** One participant's attendance facts as reported by host /status. */
export interface HostAttendanceParticipant {
  kind: ParticipantKind;
  attendance_required: boolean;
  attendance_state: string;
}

/** Host /status signal: room lifecycle plus per-participant attendance facts. */
export interface HostStatusSignal {
  room_status: "open" | "closed";
  participants: HostAttendanceParticipant[];
}

export interface PlatformStatusResult {
  status: PlatformRoomStatus;
  reason: PlatformStatusReason;
  route_health: RouteHealth;
}

// Attendance states that count as actively foreground. A required participant
// in any other state (away, stale, not_attending, manual, standby) is not
// attending, so a stale route or lapsed attendance can never read as active.
const FOREGROUND_STATES = new Set(["attending", "managed"]);

/** Build the route signal from broker route metadata (or its absence). */
export function routeSignalFromMetadata(route: RouteMetadata | undefined): RouteHealthSignal {
  if (route === undefined) return { registered: false };
  return { registered: true, route_status: route.status, host_connected: route.host_connected };
}

/** Project a route signal to the #80 RouteHealth shape (registered vs reachable). */
export function routeHealthFromSignal(route: RouteHealthSignal): RouteHealth {
  return {
    reachable: route.registered && route.route_status === "active",
    host_connected: route.host_connected ?? false
  };
}

/**
 * Derive the central platform status from existing route and host signals.
 * Order matters: terminal/closed conditions win, then route/host availability,
 * and only a healthy active route consults attendance to choose active vs idle.
 */
export function derivePlatformStatus(route: RouteHealthSignal, host: HostStatusSignal): PlatformStatusResult {
  const route_health = routeHealthFromSignal(route);
  const result = (status: PlatformRoomStatus, reason: PlatformStatusReason): PlatformStatusResult => ({
    status,
    reason,
    route_health
  });

  // Closed is terminal: an explicitly closed route, or a host that closed the
  // room, regardless of any other signal.
  if (route.registered && route.route_status === "closed") return result("closed", "route_closed");
  if (host.room_status === "closed") return result("closed", "room_closed");

  // No registered route, or an expired one, is recoverable: the same metadata
  // can resume, so it is paused rather than closed (per the issue default).
  if (!route.registered) return result("paused", "host_unavailable");
  if (route.route_status === "expired") return result("paused", "route_expired");

  // Route is active. If the host is not attending the relay (stale heartbeat or
  // stopped host), the room is paused, never active.
  if (route.host_connected !== true) return result("paused", "host_unavailable");

  // Healthy active route: active vs idle comes from host /status attendance,
  // not from broker data alone.
  const required = host.participants.filter((participant) => participant.attendance_required);
  if (required.length === 0) return result("idle", "no_foreground_required");
  const allAttending = required.every((participant) => FOREGROUND_STATES.has(participant.attendance_state));
  return allAttending ? result("active", "foreground_attending") : result("idle", "foreground_idle");
}
