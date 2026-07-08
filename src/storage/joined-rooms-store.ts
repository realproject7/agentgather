import { readFile } from "node:fs/promises";
import path from "node:path";
import { ensureSecureDir, writeSecureFile } from "./secure-fs.js";

// Device-local record of a room this user has joined as a participant (#178).
// METADATA ONLY — a participant bearer token is NEVER persisted here (the token
// lives in the per-alias token store / per-session entry). This file never leaves
// the device; there is no central membership copy.
export interface JoinedRoom {
  roomId: string;
  title: string;
  alias: string;
  baseUrl: string;
  joinedAt: string;
  lastSeen: string;
  // Device-local lifecycle flag (#210): an archived entry is hidden from the
  // dashboard by default but its metadata/history pointers are preserved for
  // recovery. Purely local — it never closes the host room or notifies anyone.
  archived?: boolean;
}

interface JoinedRoomsStore {
  rooms: JoinedRoom[];
}

export function joinedRoomsPath(home: string): string {
  return path.join(home, "joined-rooms.json");
}

export async function readJoinedRooms(home: string): Promise<JoinedRoom[]> {
  try {
    const store = JSON.parse(await readFile(joinedRoomsPath(home), "utf8")) as JoinedRoomsStore;
    return Array.isArray(store.rooms) ? store.rooms : [];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

// Upsert one joined-room record (keyed by roomId + baseUrl). Only the metadata
// fields are written — the token is dropped even if present on the input, so this
// store can never accumulate a secret.
export async function recordJoinedRoom(home: string, entry: JoinedRoom): Promise<void> {
  await ensureSecureDir(home);
  const rooms = await readJoinedRooms(home);
  const index = rooms.findIndex((room) => room.roomId === entry.roomId && room.baseUrl === entry.baseUrl);
  // Keep the best-known display title (#216): a re-record that only carries the
  // slug-like fallback (empty or === roomId) must not overwrite a real title
  // captured on an earlier join — so an offline refresh or a token-less re-add
  // never downgrades "Agent Gather Launch" back to "ag-project-0706". A title is
  // "real" when it is non-empty and not just the room id.
  const existingTitle = index === -1 ? undefined : rooms[index]?.title;
  const isRealTitle = (value: string | undefined): boolean =>
    value !== undefined && value.length > 0 && value !== entry.roomId;
  const record: JoinedRoom = {
    roomId: entry.roomId,
    title: isRealTitle(entry.title)
      ? entry.title
      : isRealTitle(existingTitle)
        ? (existingTitle as string)
        : entry.title.length > 0
          ? entry.title
          : entry.roomId,
    alias: entry.alias,
    baseUrl: entry.baseUrl,
    joinedAt: index === -1 ? entry.joinedAt : (rooms[index]?.joinedAt ?? entry.joinedAt),
    lastSeen: entry.lastSeen
  };
  // Preserve an existing archived flag across a re-record so re-joining doesn't
  // silently un-archive a room the user chose to hide (#210).
  const archived = entry.archived ?? (index === -1 ? undefined : rooms[index]?.archived);
  if (archived) record.archived = true;
  if (index === -1) rooms.push(record);
  else rooms[index] = record;
  await writeSecureFile(joinedRoomsPath(home), `${JSON.stringify({ rooms }, null, 2)}\n`);
}

// Archive/unarchive one device-local joined-room record (#210). Writes ONLY the
// joined-rooms.json store — it never touches host-owned room homes, host logs, or
// any `rooms/<id>/` data. Returns true if a matching record was updated.
export async function setJoinedRoomArchived(
  home: string,
  target: { roomId: string; baseUrl: string; archived: boolean }
): Promise<boolean> {
  const rooms = await readJoinedRooms(home);
  const index = rooms.findIndex((room) => room.roomId === target.roomId && room.baseUrl === target.baseUrl);
  const current = rooms[index];
  if (index === -1 || current === undefined) return false;
  if (target.archived) current.archived = true;
  else delete current.archived;
  await ensureSecureDir(home);
  await writeSecureFile(joinedRoomsPath(home), `${JSON.stringify({ rooms }, null, 2)}\n`);
  return true;
}

// Hard-delete one device-local joined-room record (#210). Removes ONLY the entry
// from joined-rooms.json — it deletes no host-owned room data (`rooms/<id>/`),
// host logs, or tokens. Returns true if a matching record was removed.
export async function deleteJoinedRoom(
  home: string,
  target: { roomId: string; baseUrl: string }
): Promise<boolean> {
  const rooms = await readJoinedRooms(home);
  const next = rooms.filter((room) => !(room.roomId === target.roomId && room.baseUrl === target.baseUrl));
  if (next.length === rooms.length) return false;
  await ensureSecureDir(home);
  await writeSecureFile(joinedRoomsPath(home), `${JSON.stringify({ rooms: next }, null, 2)}\n`);
  return true;
}
