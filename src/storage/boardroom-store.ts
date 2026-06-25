// Host-owned persistence for the V2 boardroom model (#140 / T3).
//
// Boardroom + channel metadata and per-participant per-channel read cursors live
// in the room's own host-owned directory (the SSOT), written under the existing
// writer lock with the same atomic, 0600 secure-file helpers. No message bodies
// and no raw tokens are stored here.
//
// A legacy bare room has no boardroom.json; `readBoardroom` projects it to a
// single #general chat channel at runtime without writing anything.
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type Boardroom,
  type ChannelReadCursor,
  DEFAULT_CHANNEL_ID,
  assertValidBoardroom,
  deriveDefaultBoardroom
} from "../protocol/boardroom.js";
import { assertSafeSlug, parsePositiveInteger } from "../protocol/validation.js";
import { withWriterLock } from "./lock.js";
import { roomPaths, type RoomPaths } from "./paths.js";
import { readCursor, readRoomState } from "./room-store.js";
import { writeSecureFile } from "./secure-fs.js";

// Read the boardroom for a room. Returns the persisted boardroom when present,
// otherwise a runtime projection of the legacy bare room (single #general chat
// channel). The legacy projection is never written back.
export async function readBoardroom(root: string, roomId: string): Promise<Boardroom> {
  const paths = roomPaths(root, roomId);
  try {
    const persisted = await readJson<Boardroom>(paths.boardroom);
    return { ...persisted, legacy: false };
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    const state = await readRoomState(paths);
    return deriveDefaultBoardroom({
      id: state.id,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt
    });
  }
}

// Persist boardroom + channel metadata (host-owned, atomic, under the writer
// lock). Validates channel ids/types/lifecycle and rejects duplicate channels.
export async function writeBoardroom(root: string, roomId: string, boardroom: Boardroom): Promise<Boardroom> {
  assertSafeSlug(roomId, "room id");
  const persisted: Boardroom = { ...boardroom, id: roomId, legacy: false };
  assertValidBoardroom(persisted);
  const paths = roomPaths(root, roomId);
  return withWriterLock(paths.lock, async () => {
    await writeJson(paths.boardroom, persisted);
    return persisted;
  });
}

// Read a participant's read position in a channel. The default #general channel
// falls back to the room's legacy per-alias cursor so existing rooms keep their
// read state with no migration.
export async function readChannelCursor(
  root: string,
  roomId: string,
  channelId: string,
  participantId: string
): Promise<number> {
  assertSafeSlug(channelId, "channel id");
  assertSafeSlug(participantId, "participant id");
  const paths = roomPaths(root, roomId);
  try {
    const record = await readJson<ChannelReadCursor>(channelCursorPath(paths, channelId, participantId));
    return record.sinceId;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    if (channelId === DEFAULT_CHANNEL_ID) return readCursor(root, roomId, participantId);
    return 0;
  }
}

// Write a participant's read position in a channel. Stored separately from
// message bodies so a later `unread` API can diff cursors against history.
export async function writeChannelCursor(
  root: string,
  roomId: string,
  channelId: string,
  participantId: string,
  sinceId: number,
  now: Date = new Date()
): Promise<ChannelReadCursor> {
  assertSafeSlug(channelId, "channel id");
  assertSafeSlug(participantId, "participant id");
  parsePositiveInteger(sinceId, "cursor sinceId");
  const paths = roomPaths(root, roomId);
  const record: ChannelReadCursor = {
    participantId,
    channelId,
    sinceId,
    updatedAt: now.toISOString()
  };
  await writeJson(channelCursorPath(paths, channelId, participantId), record);
  return record;
}

function channelCursorPath(paths: RoomPaths, channelId: string, participantId: string): string {
  return path.join(paths.channelCursors, channelId, `${participantId}.json`);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeSecureFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
