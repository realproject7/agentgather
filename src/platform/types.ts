// Control plane metadata types.
//
// These describe the central, platform-managed view of a room: enough metadata
// to list, route, and monitor rooms without ever holding canonical room data.
// The control plane is a separate surface from the host room server: it must
// never store message bodies, Room Brief bodies, participant bearer tokens,
// tokenized invite URLs, or any message-derived content. See #80.

import type { ParticipantKind } from "../protocol/index.js";

/**
 * Central platform status for a room. This is the control-plane metadata status
 * and is deliberately distinct from the host room server's open/closed status.
 * #80 only defines and stores these values; #81 owns deriving them from host
 * state and route health.
 */
export type PlatformRoomStatus = "active" | "idle" | "paused" | "closed";

export const PLATFORM_ROOM_STATUSES: readonly PlatformRoomStatus[] = [
  "active",
  "idle",
  "paused",
  "closed"
];

/**
 * Reason a room holds its current platform status. Reasons that correspond to an
 * existing relay condition reuse that exact code (`route_closed`,
 * `host_unavailable`, `route_expired`) so consumers share the tunnel vocabulary.
 * The status itself remains a PlatformRoomStatus; the reason only explains it.
 */
export type PlatformStatusReason =
  | "foreground_attending"
  | "foreground_idle"
  | "no_foreground_required"
  | "host_unavailable"
  | "route_expired"
  | "route_closed"
  | "room_closed";

export const PLATFORM_STATUS_REASONS: readonly PlatformStatusReason[] = [
  "foreground_attending",
  "foreground_idle",
  "no_foreground_required",
  "host_unavailable",
  "route_expired",
  "route_closed",
  "room_closed"
];

/** Coarse role a roster member holds, for central metadata only. */
export type RosterRole = "host" | "member";

/**
 * Safe roster metadata for the control plane. Limited to alias, kind, role, a
 * short status label, and a safe last-seen timestamp — never bearer tokens,
 * token hashes, display content, or message-derived data.
 */
export interface RosterEntry {
  alias: string;
  kind: ParticipantKind;
  role: RosterRole;
  status: string;
  last_seen_at?: string;
}

/** Route reachability/health metadata. Carries no request or response content. */
export interface RouteHealth {
  reachable: boolean;
  host_connected: boolean;
  checked_at?: string;
}

/**
 * Central metadata record for one room. Every field here is non-canonical
 * routing/monitoring metadata. Message bodies, brief bodies, tokens, and
 * tokenized URLs are intentionally absent from this shape.
 */
export interface ControlPlaneRoom {
  room_id: string;
  title: string;
  // Owner identity for the future account layer. #80 keeps this an opaque
  // metadata value only; it does not authenticate or authorize anything.
  owner_user_id: string;
  route_url: string;
  route_slug: string;
  status: PlatformRoomStatus;
  // Optional explanation of the current status (e.g. host_unavailable). The
  // status field stays authoritative; this only adds a displayable reason.
  status_reason?: PlatformStatusReason;
  roster: RosterEntry[];
  route_health: RouteHealth;
  // Integer cursor only: the last host message id the platform has synced. It
  // is a position, never message content.
  last_synced_message_id: number;
  last_seen_at?: string;
  last_synced_at?: string;
  created_at: string;
  updated_at: string;
}

/** Input accepted when registering or updating central room metadata. */
export interface ControlPlaneRoomInput {
  room_id: string;
  title: string;
  owner_user_id: string;
  route_url: string;
  route_slug?: string;
  status: PlatformRoomStatus;
  status_reason?: PlatformStatusReason;
  roster?: RosterEntry[];
  route_health?: RouteHealth;
  last_synced_message_id?: number;
  last_seen_at?: string;
  last_synced_at?: string;
}
