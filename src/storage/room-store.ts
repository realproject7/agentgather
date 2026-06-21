import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertSafeSlug,
  buildMessage,
  clientMessageInputFromRecord,
  parseMentions,
  type ClientMessageInput,
  type Message,
  type Participant,
  type RoomBrief,
  type RoomState
} from "../protocol/index.js";
import { withWriterLock } from "./lock.js";
import { roomPaths, type RoomPaths } from "./paths.js";

export const MAX_BRIEF_LENGTH = 16_000;

export interface CreateRoomOptions {
  root: string;
  roomId: string;
  hostAlias: string;
  now?: Date;
  briefBody?: string;
}

export interface AppendMessageOptions {
  root: string;
  roomId: string;
  from: string;
  input: unknown;
  now?: Date;
}

export interface UpdateBriefOptions {
  root: string;
  roomId: string;
  body: string;
  updatedBy: string;
  now?: Date;
}

export interface CursorRecord {
  alias: string;
  sinceId: number;
  updatedAt: string;
}

export async function createRoom(options: CreateRoomOptions): Promise<RoomState> {
  assertSafeSlug(options.roomId, "room id");
  assertSafeSlug(options.hostAlias, "host alias");
  const now = options.now ?? new Date();
  const paths = roomPaths(options.root, options.roomId);
  await ensureRoomDirectories(paths);

  const briefBody = options.briefBody ?? "";
  assertBriefSize(briefBody);
  const state: RoomState = {
    id: options.roomId,
    status: "open",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    next_message_id: 1,
    brief_version: 1,
    brief_updated_at: now.toISOString(),
    brief_updated_by: options.hostAlias
  };

  await writeNewJson(paths.state, state);
  await writeNewJson(paths.participants, []);
  await writeFile(paths.brief, briefBody, { flag: "wx" });
  await writeFile(paths.messages, "", { flag: "wx" });
  return state;
}

export async function updateBrief(options: UpdateBriefOptions): Promise<RoomBrief> {
  assertSafeSlug(options.roomId, "room id");
  assertSafeSlug(options.updatedBy, "updated by");
  assertBriefSize(options.body);
  const now = options.now ?? new Date();
  const paths = roomPaths(options.root, options.roomId);

  return withWriterLock(paths.lock, async () => {
    const state = await readRoomState(paths);
    const updatedState: RoomState = {
      ...state,
      updatedAt: now.toISOString(),
      brief_version: state.brief_version + 1,
      brief_updated_at: now.toISOString(),
      brief_updated_by: options.updatedBy
    };
    await writeFile(paths.brief, options.body);
    await writeJson(paths.state, updatedState);
    return {
      body: options.body,
      brief_version: updatedState.brief_version,
      brief_updated_at: updatedState.brief_updated_at,
      brief_updated_by: updatedState.brief_updated_by
    };
  });
}

export async function appendMessage(options: AppendMessageOptions): Promise<Message> {
  assertSafeSlug(options.roomId, "room id");
  assertSafeSlug(options.from, "from");
  const paths = roomPaths(options.root, options.roomId);
  const input = clientMessageInputFromRecord(options.input);
  const now = options.now ?? new Date();

  return withWriterLock(paths.lock, async () => {
    const state = await readRoomState(paths);
    const participants = await readParticipants(paths);
    const message = createMessage(input, {
      id: state.next_message_id,
      room: state.id,
      from: options.from,
      roster: participants.map((participant) => participant.alias),
      now
    });
    await appendJsonLine(paths.messages, message);
    await writeJson(paths.state, {
      ...state,
      updatedAt: now.toISOString(),
      next_message_id: message.id + 1
    });
    return message;
  });
}

export async function readMessages(root: string, roomId: string): Promise<Message[]> {
  const paths = roomPaths(root, roomId);
  return readJsonLines<Message>(paths.messages);
}

export async function readCursor(root: string, roomId: string, alias: string): Promise<number> {
  assertSafeSlug(alias, "alias");
  const paths = roomPaths(root, roomId);
  try {
    const record = await readJson<CursorRecord>(cursorPath(paths, alias));
    return record.sinceId;
  } catch (error) {
    if (isNotFoundError(error)) return 0;
    throw error;
  }
}

export async function writeCursor(
  root: string,
  roomId: string,
  alias: string,
  sinceId: number,
  now: Date = new Date()
): Promise<CursorRecord> {
  assertSafeSlug(alias, "alias");
  if (!Number.isSafeInteger(sinceId) || sinceId < 0) {
    throw new Error("cursor sinceId must be a non-negative safe integer");
  }
  const paths = roomPaths(root, roomId);
  await mkdir(paths.cursors, { recursive: true });
  const record: CursorRecord = {
    alias,
    sinceId,
    updatedAt: now.toISOString()
  };
  await writeJson(cursorPath(paths, alias), record);
  return record;
}

export async function writeParticipants(
  root: string,
  roomId: string,
  participants: Participant[]
): Promise<void> {
  const paths = roomPaths(root, roomId);
  for (const participant of participants) {
    assertSafeSlug(participant.alias, "participant alias");
  }
  await withWriterLock(paths.lock, async () => {
    await writeJson(paths.participants, participants);
  });
}

export async function readRoomState(paths: RoomPaths): Promise<RoomState> {
  return readJson<RoomState>(paths.state);
}

export async function readParticipants(paths: RoomPaths): Promise<Participant[]> {
  return readJson<Participant[]>(paths.participants);
}

export async function recoverNextMessageId(messagesPath: string): Promise<number> {
  const messages = await readJsonLines<Message>(messagesPath);
  return messages.reduce((highest, message) => Math.max(highest, message.id), 0) + 1;
}

export async function recoverRoomState(root: string, roomId: string): Promise<RoomState> {
  const paths = roomPaths(root, roomId);
  return withWriterLock(paths.lock, async () => {
    const state = await readRoomState(paths);
    const recoveredNextId = await recoverNextMessageId(paths.messages);
    if (state.next_message_id >= recoveredNextId) return state;
    const recoveredState = {
      ...state,
      next_message_id: recoveredNextId
    };
    await writeJson(paths.state, recoveredState);
    return recoveredState;
  });
}

function createMessage(
  input: ClientMessageInput,
  options: { id: number; room: string; from: string; roster: string[]; now: Date }
): Message {
  return buildMessage(input, {
    id: options.id,
    room: options.room,
    from: options.from,
    now: options.now,
    mentions: parseMentions(input.text, options.roster)
  });
}

async function ensureRoomDirectories(paths: RoomPaths): Promise<void> {
  await mkdir(paths.cursors, { recursive: true });
}

function assertBriefSize(body: string): void {
  if (body.length > MAX_BRIEF_LENGTH) {
    throw new Error(`brief body must be <= ${MAX_BRIEF_LENGTH} characters`);
  }
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  await writeFile(path, line, { flag: "a" });
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeNewJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, "utf8");
  if (raw.trim().length === 0) return [];
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function cursorPath(paths: RoomPaths, alias: string): string {
  return path.join(paths.cursors, `${alias}.json`);
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
