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
  type Channel,
  type ChannelReadCursor,
  type ChannelView,
  DEFAULT_CHANNEL_ID,
  assertValidBoardroom,
  defaultChannel,
  deriveDefaultBoardroom,
  summarizeUnread
} from "../protocol/boardroom.js";
import { assertSafeSlug, parsePositiveInteger } from "../protocol/validation.js";
import { withWriterLock } from "./lock.js";
import { roomPaths, type RoomPaths } from "./paths.js";
import { readCursor, readMessages, readRoomState } from "./room-store.js";
import { writeSecureFile } from "./secure-fs.js";

// Read the boardroom for a room. Returns the persisted boardroom when present,
// otherwise a runtime projection of the legacy bare room (single #general chat
// channel). The legacy projection is never written back.
export async function readBoardroom(root: string, roomId: string): Promise<Boardroom> {
  return readBoardroomUnlocked(roomPaths(root, roomId));
}

// Persist boardroom + channel metadata (host-owned, atomic, under the writer
// lock). Validates channel ids/types/lifecycle and rejects duplicate channels.
export async function writeBoardroom(root: string, roomId: string, boardroom: Boardroom): Promise<Boardroom> {
  assertSafeSlug(roomId, "room id");
  const paths = roomPaths(root, roomId);
  return withWriterLock(paths.lock, async () => persistBoardroom(paths, { ...boardroom, id: roomId }));
}

// Host create-boardroom flow (T7): create/overwrite the boardroom metadata for a
// room, defaulting to a single #general chat channel when none are given.
export async function createBoardroom(
  root: string,
  roomId: string,
  options: { name?: string; channels?: Channel[] } = {},
  now: Date = new Date()
): Promise<Boardroom> {
  assertSafeSlug(roomId, "room id");
  const iso = now.toISOString();
  const boardroom: Boardroom = {
    id: roomId,
    channels: options.channels !== undefined && options.channels.length > 0 ? options.channels : [defaultChannel(iso)],
    lifecycle: "active",
    createdAt: iso,
    updatedAt: iso,
    legacy: false
  };
  if (options.name !== undefined) boardroom.name = options.name;
  const paths = roomPaths(root, roomId);
  return withWriterLock(paths.lock, async () => persistBoardroom(paths, boardroom));
}

// Host channel-create flow (T7): append a channel (chat|forum chosen at create
// time) to the boardroom, materializing a legacy room's #general projection on
// first write. Rejects a duplicate channel id.
export async function addChannel(root: string, roomId: string, channel: Channel, now: Date = new Date()): Promise<Boardroom> {
  assertSafeSlug(roomId, "room id");
  const paths = roomPaths(root, roomId);
  return withWriterLock(paths.lock, async () => {
    const current = await readBoardroomUnlocked(paths);
    if (current.channels.some((c) => c.id === channel.id)) {
      throw new Error(`channel already exists: ${channel.id}`);
    }
    const next: Boardroom = {
      ...current,
      channels: [...current.channels, channel],
      updatedAt: now.toISOString(),
      legacy: false
    };
    return persistBoardroom(paths, next);
  });
}

async function persistBoardroom(paths: RoomPaths, boardroom: Boardroom): Promise<Boardroom> {
  const persisted: Boardroom = { ...boardroom, legacy: false };
  assertValidBoardroom(persisted);
  await writeJson(paths.boardroom, persisted);
  return persisted;
}

async function readBoardroomUnlocked(paths: RoomPaths): Promise<Boardroom> {
  try {
    const persisted = await readJson<Boardroom>(paths.boardroom);
    return { ...persisted, legacy: false };
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    const state = await readRoomState(paths);
    return deriveDefaultBoardroom({ id: state.id, createdAt: state.createdAt, updatedAt: state.updatedAt });
  }
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

// T5 bridge: project a chat channel as a read-only view over the existing
// message log. The default #general channel maps to the room's existing log (no
// duplicated storage); other channels have no per-channel store yet (T6/T8) and
// project as empty. unread/lastReadId come from the T3 per-channel cursor, so an
// idle participant can inspect history/unread without foreground attended mode.
// Message visibility (broadcast `status` vs directed mentions) is preserved by
// returning the log messages unchanged.
export async function readChannelView(
  root: string,
  roomId: string,
  channelId: string,
  participantId: string
): Promise<ChannelView> {
  assertSafeSlug(channelId, "channel id");
  assertSafeSlug(participantId, "participant id");
  const boardroom = await readBoardroom(root, roomId);
  const channel = boardroom.channels.find((c) => c.id === channelId);
  if (channel === undefined) throw new Error(`channel not found: ${channelId}`);

  // Only the default #general chat channel is backed by the existing log in the
  // MVP; other channels are not yet stored, so they project as empty.
  const messages = channelId === DEFAULT_CHANNEL_ID ? await readMessages(root, roomId) : [];
  const lastReadId = await readChannelCursor(root, roomId, channelId, participantId);
  const { unread, latestId } = summarizeUnread(messages, lastReadId);
  return { channelId, type: channel.type, messages, unread, lastReadId, latestId };
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
