import { readFile } from "node:fs/promises";
import path from "node:path";
import { deleteJoinedHistory } from "./joined-history-store.js";
import { withWriterLock } from "./lock.js";
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

export function joinedRoomsLockPath(home: string): string {
  return path.join(home, "joined-rooms.lock");
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
//
// This is the EXPLICIT local join/import path (CLI `room join`, dashboard invite
// import): its caller intentionally selects the opening identity, so the alias it
// carries becomes the selected identity for the row (#248).
export async function recordJoinedRoom(home: string, entry: JoinedRoom): Promise<void> {
  await ensureSecureDir(home);
  // Serialize the whole read-modify-write: a concurrent record/archive/delete on
  // this device-local store must not read a stale list and drop the other's edit.
  await withWriterLock(joinedRoomsLockPath(home), async () => {
    await upsertJoinedRoomLocked(home, entry, { keepSelectedAlias: false });
  });
}

// Refresh the non-identity metadata of a joined-room record from an observing
// caller — the browser-origin, loopback-only room bridge (#248). Title/last-seen
// may move, but the alias already stored for an existing (roomId, baseUrl) row is
// the dashboard-selected opening identity and is NEVER replaced here: a stale room
// tab authenticated as another participant must not be able to repoint the row at
// its own credential. Identity authority is the function you call, not call order.
export async function refreshJoinedRoomMetadata(home: string, entry: JoinedRoom): Promise<void> {
  await ensureSecureDir(home);
  await withWriterLock(joinedRoomsLockPath(home), async () => {
    await upsertJoinedRoomLocked(home, entry, { keepSelectedAlias: true });
  });
}

async function upsertJoinedRoomLocked(
  home: string,
  entry: JoinedRoom,
  options: { keepSelectedAlias: boolean }
): Promise<void> {
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
  // Selected opening identity (#248): on a metadata-only refresh the alias already
  // stored for this row wins. A row that carries no alias yet opens nothing (the
  // dashboard answers "no participant alias" instead), so filling that in is safe
  // and keeps the first-time bridge useful.
  const existingAlias = index === -1 ? undefined : rooms[index]?.alias;
  const keptAlias = options.keepSelectedAlias && existingAlias !== undefined && existingAlias.length > 0;
  const record: JoinedRoom = {
    roomId: entry.roomId,
    title: isRealTitle(entry.title)
      ? entry.title
      : isRealTitle(existingTitle)
        ? (existingTitle as string)
        : entry.title.length > 0
          ? entry.title
          : entry.roomId,
    alias: keptAlias ? (existingAlias as string) : entry.alias,
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
//
// Archiving also drops this device's offline history snapshot for the row (#247):
// the user is putting the room away, so the saved transcript goes with it rather
// than lingering on disk for a row the dashboard no longer shows.
export async function setJoinedRoomArchived(
  home: string,
  target: { roomId: string; baseUrl: string; archived: boolean }
): Promise<boolean> {
  await ensureSecureDir(home);
  if (target.archived) await deleteJoinedHistory(home, { roomId: target.roomId, baseUrl: target.baseUrl });
  return withWriterLock(joinedRoomsLockPath(home), async () => {
    const rooms = await readJoinedRooms(home);
    const index = rooms.findIndex((room) => room.roomId === target.roomId && room.baseUrl === target.baseUrl);
    const current = rooms[index];
    if (index === -1 || current === undefined) return false;
    if (target.archived) current.archived = true;
    else delete current.archived;
    await writeSecureFile(joinedRoomsPath(home), `${JSON.stringify({ rooms }, null, 2)}\n`);
    return true;
  });
}

// Hard-delete one device-local joined-room record (#210). Removes ONLY the entry
// from joined-rooms.json plus this device's own offline snapshot for it (#247) —
// it deletes no host-owned room data (`rooms/<id>/`), host logs, or tokens.
// Returns true if a matching record was removed.
export async function deleteJoinedRoom(
  home: string,
  target: { roomId: string; baseUrl: string }
): Promise<boolean> {
  await ensureSecureDir(home);
  await deleteJoinedHistory(home, { roomId: target.roomId, baseUrl: target.baseUrl });
  return withWriterLock(joinedRoomsLockPath(home), async () => {
    const rooms = await readJoinedRooms(home);
    const next = rooms.filter((room) => !(room.roomId === target.roomId && room.baseUrl === target.baseUrl));
    if (next.length === rooms.length) return false;
    await writeSecureFile(joinedRoomsPath(home), `${JSON.stringify({ rooms: next }, null, 2)}\n`);
    return true;
  });
}
