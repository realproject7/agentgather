// Control plane read API skeleton.
//
// Framework-agnostic handlers for listing and reading central room metadata.
// They return an HTTP-shaped { status, body } so the future production auth
// layer can mount them behind real authentication. Scoping is by a concrete
// platform account/owner identity; local callers can use a configurable dev
// owner identity until the operator selects a production auth provider.

import {
  ControlPlaneNotFoundError,
  listControlPlaneRooms,
  readControlPlaneRoom
} from "./registry.js";
import { resolveOwnerAccount, type PlatformOwnerQuery } from "./accounts.js";
import type { ControlPlaneRoom, PublicChannel } from "./types.js";
import { readBoardroom } from "../storage/index.js";
import { DEFAULT_CHANNEL_ID, DEFAULT_CHANNEL_NAME } from "../protocol/index.js";

export interface PlatformApiResponse {
  status: number;
  body: unknown;
}

export type PlatformApiQuery = PlatformOwnerQuery;

/** Public shape of a hosted room: control-plane metadata plus sanitized channels. */
export type PublicRoom = ControlPlaneRoom & { channels: PublicChannel[] };

/** GET-style handler: list the central metadata for an owner's rooms. */
export async function listRoomsResponse(root: string, query: PlatformApiQuery): Promise<PlatformApiResponse> {
  const owner = ownerOrError(query);
  if (owner === null) return unauthorized();
  const rooms = (await listControlPlaneRooms(root)).filter((room) => room.owner_user_id === owner);
  const withChannels = await Promise.all(rooms.map((room) => attachChannels(root, room)));
  return { status: 200, body: { ok: true, rooms: withChannels } };
}

/** GET-style handler: read one room's central metadata for an owner. */
export async function readRoomResponse(
  root: string,
  roomId: string,
  query: PlatformApiQuery
): Promise<PlatformApiResponse> {
  const owner = ownerOrError(query);
  if (owner === null) return unauthorized();
  let room: ControlPlaneRoom;
  try {
    room = await readControlPlaneRoom(root, roomId);
  } catch (error) {
    if (error instanceof ControlPlaneNotFoundError) return notFound();
    throw error;
  }
  // A non-owner is told the room does not exist rather than that it is hidden,
  // so the API never confirms the existence of another owner's room.
  if (room.owner_user_id !== owner) return notFound();
  return { status: 200, body: { ok: true, room: await attachChannels(root, room) } };
}

// Attach the room's sanitized channel list to its control-plane metadata. Channels
// are read from the host-owned boardroom store and reduced to exactly {id, name,
// type}; a room with no boardroom store record (e.g. a legacy bare room whose store
// was never materialized) falls back to a single #general chat channel, matching
// the room server's own runtime projection. Channel reads never widen the payload:
// no token, invite/card URL, lifecycle, cursor, or message content crosses over.
async function attachChannels(root: string, room: ControlPlaneRoom): Promise<PublicRoom> {
  let boardroom;
  try {
    boardroom = await readBoardroom(root, room.room_id);
  } catch (error) {
    // No host boardroom store or room-state record for this room: project the
    // legacy default, exactly as the host room server does at runtime. Only a
    // genuine "no store" (ENOENT) falls back; any other failure (e.g. a corrupt
    // store) is a real error and propagates as a 500 rather than being masked.
    const isMissingStore = error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT";
    if (isMissingStore) {
      return { ...room, channels: [{ id: DEFAULT_CHANNEL_ID, name: DEFAULT_CHANNEL_NAME, type: "chat" }] };
    }
    throw error;
  }
  const channels = boardroom.channels
    .filter((channel) => channel.lifecycle !== "removed")
    .map((channel) => ({ id: channel.id, name: channel.name, type: channel.type }));
  return { ...room, channels };
}

function ownerOrError(query: PlatformApiQuery): string | null {
  try {
    return resolveOwnerAccount(query)?.user_id ?? null;
  } catch {
    return null;
  }
}

function unauthorized(): PlatformApiResponse {
  return { status: 401, body: { ok: false, error: "unauthorized", message: "owner account is required" } };
}

function notFound(): PlatformApiResponse {
  return { status: 404, body: { ok: false, error: "not_found", message: "no such room" } };
}
