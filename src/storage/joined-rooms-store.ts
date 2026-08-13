import { readFile } from "node:fs/promises";
import path from "node:path";
import { deleteJoinedHistory } from "./joined-history-store.js";
import { withWriterLock } from "./lock.js";
import { ensureSecureDir, isNotFoundError, writeSecureFile } from "./secure-fs.js";

// Device-local record of a room this user has joined as a participant (#178).
// METADATA ONLY — a participant bearer token is NEVER persisted here (the token
// lives in the per-alias token store / per-session entry). This file never leaves
// the device; there is no central membership copy.
// The participant kind of a seat, as the HOST reported it (#311). Deliberately
// optional everywhere: a row written before #311, or by a path that never learned
// the kind, carries none — and "unknown" is the honest answer for it. Nothing here
// ever infers a kind from an alias, a naming convention, or a default (#293: the
// defect was starting from a claim about the user's data).
export type JoinedRoomKind = "human" | "agent";

// One credential this device actually holds for a room, and the kind it seats you
// as. Recorded per alias because a device can hold several credentials for one
// room while the row itself opens exactly one of them: the row's `kind` describes
// only its selected alias, so without this the kind of every other held credential
// is lost on the next import.
export interface JoinedRoomSeat {
  alias: string;
  kind?: JoinedRoomKind;
}

export interface JoinedRoom {
  roomId: string;
  title: string;
  alias: string;
  baseUrl: string;
  joinedAt: string;
  lastSeen: string;
  // Kind of THIS row's selected alias (#311). Absent = unknown, never inferred.
  kind?: JoinedRoomKind;
  // Every seat this device has learned for this room, including ones the row is
  // not currently opening as. Never a token — the alias only.
  seats?: JoinedRoomSeat[];
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
    if (isNotFoundError(error)) return [];
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
  // Seat kind (#311). The rule is the same one that governs the alias: a kind is a
  // statement about a specific participant, so it may only travel with the alias it
  // was observed for.
  //
  //  - explicit record (invite import): the caller learned this alias's kind from
  //    the host, so it wins. If it learned none, the row keeps its stored kind ONLY
  //    when the alias is unchanged — a re-import that switches alias must not carry
  //    the previous participant's kind onto the new one, it must go back to unknown.
  //  - metadata refresh (bridge): the stored alias is kept, so a kind is accepted
  //    only when the caller is talking about that same alias.
  const aliasUnchanged = existingAlias !== undefined && existingAlias === record.alias;
  const existingKind = index === -1 ? undefined : rooms[index]?.kind;
  const kind = entry.kind ?? (aliasUnchanged ? existingKind : undefined);
  if (kind !== undefined) record.kind = kind;
  const seats = mergeSeats(index === -1 ? undefined : rooms[index]?.seats, entry.seats, record.alias, kind);
  if (seats.length > 0) record.seats = seats;
  // Preserve an existing archived flag across a re-record so re-joining doesn't
  // silently un-archive a room the user chose to hide (#210).
  const archived = entry.archived ?? (index === -1 ? undefined : rooms[index]?.archived);
  if (archived) record.archived = true;
  if (index === -1) rooms.push(record);
  else rooms[index] = record;
  await writeSecureFile(joinedRoomsPath(home), `${JSON.stringify({ rooms }, null, 2)}\n`);
}

// Accumulate what this device knows about the seats of one room (#311).
//
// Additive and non-destructive: a seat already recorded keeps its kind unless the
// caller supplies one for that same alias, so importing an agent invite never
// erases what we learned about the human credential still held for the room —
// which is exactly the state the "Join as" choice needs to see. An alias with no
// kind is still recorded, as a held seat whose kind is unknown; it is never
// promoted to a kind by being seen again.
function mergeSeats(
  existing: readonly JoinedRoomSeat[] | undefined,
  incoming: readonly JoinedRoomSeat[] | undefined,
  selectedAlias: string,
  selectedKind: JoinedRoomKind | undefined
): JoinedRoomSeat[] {
  const merged = new Map<string, JoinedRoomSeat>();
  for (const seat of existing ?? []) {
    if (typeof seat?.alias === "string" && seat.alias.length > 0) merged.set(seat.alias, { alias: seat.alias, ...(seat.kind === undefined ? {} : { kind: seat.kind }) });
  }
  const learned = [...(incoming ?? []), ...(selectedAlias.length > 0 ? [{ alias: selectedAlias, kind: selectedKind }] : [])];
  for (const seat of learned) {
    if (typeof seat?.alias !== "string" || seat.alias.length === 0) continue;
    const kind = seat.kind ?? merged.get(seat.alias)?.kind;
    merged.set(seat.alias, { alias: seat.alias, ...(kind === undefined ? {} : { kind }) });
  }
  return [...merged.values()];
}

// Archive/unarchive one device-local joined-room record (#210). Writes ONLY the
// joined-rooms.json store — it never touches host-owned room homes, host logs, or
// any `rooms/<id>/` data. Returns true if a matching record was updated.
//
// Archiving KEEPS this device's offline history snapshot (#247): archive is a
// reversible hide/restore, and once the host is gone that transcript cannot be
// rebuilt from anywhere — so un-archiving restores a readable row. Only an explicit
// delete clears it.
export async function setJoinedRoomArchived(
  home: string,
  target: { roomId: string; baseUrl: string; archived: boolean }
): Promise<boolean> {
  await ensureSecureDir(home);
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

// One device-local joined room addressed by the pair that keys the store. Bulk
// callers pass these; a row is touched only when BOTH fields match, so a bulk
// action can never sweep a sibling room that merely shares a host (#210).
export interface JoinedRoomTarget {
  roomId: string;
  baseUrl: string;
}

export interface BulkJoinedRoomResult {
  // Distinct targets after de-duplication — repeating a target is not an error
  // and never counts a row twice.
  requested: number;
  // Targets that matched a stored row.
  matched: number;
  // Rows this call actually changed. Archiving an already-archived row matches
  // but changes nothing, so `changed` is the honest count for the UI to report.
  changed: number;
  // Targets with no stored row (already deleted elsewhere, or never present).
  missing: number;
}

function joinedRoomKey(target: { roomId: string; baseUrl: string }): string {
  // Length-prefixed so ("ab", "c") and ("a", "bc") cannot collide into one key.
  return `${target.roomId.length}:${target.roomId}|${target.baseUrl}`;
}

function dedupeTargets(targets: readonly JoinedRoomTarget[]): Map<string, JoinedRoomTarget> {
  const unique = new Map<string, JoinedRoomTarget>();
  for (const target of targets) unique.set(joinedRoomKey(target), target);
  return unique;
}

// Archive/unarchive MANY device-local rows in one pass (#277). Same semantics as
// setJoinedRoomArchived, including #247: archiving KEEPS this device's offline
// snapshot; only delete clears it.
//
// Exactly-the-selection is structural, not checked afterwards: rows outside the
// target set are carried into the written array untouched, by identity — there is
// no filter, index arithmetic, or re-sort that could drop or reorder a bystander.
//
// Partial failure: the whole batch is one read-modify-write under ONE writer lock
// and ONE atomic replacement write, so it is all-or-nothing. A throw before the
// write (unreadable store) leaves the file exactly as it was; the write itself is
// a temp-file rename, so it cannot land half-applied. There is no state in which
// some selected rows are archived and the rest silently are not.
export async function setJoinedRoomsArchived(
  home: string,
  targets: readonly JoinedRoomTarget[],
  archived: boolean
): Promise<BulkJoinedRoomResult> {
  await ensureSecureDir(home);
  const unique = dedupeTargets(targets);
  if (unique.size === 0) return { requested: 0, matched: 0, changed: 0, missing: 0 };
  return withWriterLock(joinedRoomsLockPath(home), async () => {
    const rooms = await readJoinedRooms(home);
    let matched = 0;
    let changed = 0;
    for (const room of rooms) {
      if (!unique.has(joinedRoomKey(room))) continue; // bystander: untouched
      matched += 1;
      const wasArchived = room.archived === true;
      if (wasArchived === archived) continue;
      changed += 1;
      if (archived) room.archived = true;
      else delete room.archived;
    }
    // Skip the write entirely when nothing changed: an all-no-op batch should not
    // rewrite the file and bump its mtime.
    if (changed > 0) await writeSecureFile(joinedRoomsPath(home), `${JSON.stringify({ rooms }, null, 2)}\n`);
    return { requested: unique.size, matched, changed, missing: unique.size - matched };
  });
}

// Hard-delete MANY device-local joined-room records plus their own offline
// snapshots (#277). Removes ONLY joined-rooms.json entries and this device's
// snapshots — never host-owned room data, host logs, or tokens.
//
// Row removal is one atomic write under one lock, so the row store is never left
// half-deleted. Snapshots are cleared afterwards, keeping #210/#247's row-first
// ordering: once a row is gone no accepted-but-unwritten bridge post can still
// land, and the snapshot removal waits on any write already in flight.
//
// If a snapshot removal fails, every other target is still attempted and the
// failure is raised afterwards rather than swallowed — an orphaned snapshot is a
// real inconsistency and must not be reported as a clean batch. The error names
// only a count: no room id, host, or filesystem path.
export async function deleteJoinedRooms(
  home: string,
  targets: readonly JoinedRoomTarget[]
): Promise<BulkJoinedRoomResult> {
  await ensureSecureDir(home);
  const unique = dedupeTargets(targets);
  if (unique.size === 0) return { requested: 0, matched: 0, changed: 0, missing: 0 };
  const removed = await withWriterLock(joinedRoomsLockPath(home), async () => {
    const rooms = await readJoinedRooms(home);
    const next = rooms.filter((room) => !unique.has(joinedRoomKey(room)));
    const count = rooms.length - next.length;
    if (count > 0) await writeSecureFile(joinedRoomsPath(home), `${JSON.stringify({ rooms: next }, null, 2)}\n`);
    return count;
  });
  // Unconditional, like the single-row path: a snapshot must never outlive its
  // row, even if the row was already gone when this call arrived.
  let snapshotFailures = 0;
  for (const target of unique.values()) {
    try {
      await deleteJoinedHistory(home, { roomId: target.roomId, baseUrl: target.baseUrl });
    } catch {
      snapshotFailures += 1;
    }
  }
  if (snapshotFailures > 0) {
    throw new Error(
      `${removed} joined-room ${removed === 1 ? "row was" : "rows were"} removed, but ${snapshotFailures} offline ${snapshotFailures === 1 ? "snapshot" : "snapshots"} could not be cleared`
    );
  }
  return { requested: unique.size, matched: removed, changed: removed, missing: unique.size - removed };
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
  // Row FIRST, snapshot second (#247, @re1). A bridge write re-checks the row while
  // holding the snapshot lock, so once the row is gone no accepted-but-unwritten
  // post can still land; and the snapshot removal below waits for any write already
  // in flight rather than racing it.
  const removed = await withWriterLock(joinedRoomsLockPath(home), async () => {
    const rooms = await readJoinedRooms(home);
    const next = rooms.filter((room) => !(room.roomId === target.roomId && room.baseUrl === target.baseUrl));
    if (next.length === rooms.length) return false;
    await writeSecureFile(joinedRoomsPath(home), `${JSON.stringify({ rooms: next }, null, 2)}\n`);
    return true;
  });
  // Unconditional: a snapshot must never outlive its row, even if the row was
  // already gone when this call arrived.
  await deleteJoinedHistory(home, { roomId: target.roomId, baseUrl: target.baseUrl });
  return removed;
}
