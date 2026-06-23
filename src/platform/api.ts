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
import type { ControlPlaneRoom } from "./types.js";

export interface PlatformApiResponse {
  status: number;
  body: unknown;
}

export type PlatformApiQuery = PlatformOwnerQuery;

/** GET-style handler: list the central metadata for an owner's rooms. */
export async function listRoomsResponse(root: string, query: PlatformApiQuery): Promise<PlatformApiResponse> {
  const owner = ownerOrError(query);
  if (owner === null) return unauthorized();
  const rooms = (await listControlPlaneRooms(root)).filter((room) => room.owner_user_id === owner);
  return { status: 200, body: { ok: true, rooms } };
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
  return { status: 200, body: { ok: true, room } };
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
