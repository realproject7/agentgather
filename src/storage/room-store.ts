import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertSafeSlug,
  buildMessage,
  clientMessageInputFromRecord,
  parseMentions,
  type ActiveSession,
  type ClientMessageInput,
  type AttendancePolicy,
  type Message,
  type Participant,
  type RoomBrief,
  type RoomState
} from "../protocol/index.js";
import { withWriterLock } from "./lock.js";
import { roomPaths, type RoomPaths } from "./paths.js";
import { appendSecureFile, ensureSecureDir, writeSecureFile } from "./secure-fs.js";

export const MAX_BRIEF_LENGTH = 16_000;

export class RoomLogFullError extends Error {
  constructor() {
    super("room message log is full");
  }
}

// Thrown when a start is requested while a session is already active (T11 MVP:
// one active session per room). Mapped to HTTP 409 by the server.
export class ActiveSessionExistsError extends Error {
  constructor() {
    super("an active chat session is already running");
  }
}

export interface CreateRoomOptions {
  root: string;
  roomId: string;
  hostAlias: string;
  now?: Date;
  expiresAt?: Date;
  briefBody?: string;
  attendancePolicy?: AttendancePolicy;
}

export interface AppendMessageOptions {
  root: string;
  roomId: string;
  from: string;
  input: unknown;
  now?: Date;
  maxMessages?: number;
}

export interface AppendMessageResult {
  message: Message;
  idempotent: boolean;
}

export interface AppendServerMessageOptions {
  root: string;
  roomId: string;
  from: string;
  text: string;
  now?: Date;
}

export interface UpdateBriefOptions {
  root: string;
  roomId: string;
  body: string;
  updatedBy: string;
  now?: Date;
}

export interface UpdateAttendancePolicyOptions {
  root: string;
  roomId: string;
  policy: AttendancePolicy;
  updatedBy: string;
  now?: Date;
}

export interface StartActiveSessionOptions {
  root: string;
  roomId: string;
  channelId: string;
  startedBy: string;
  expectedDurationM: number;
  requestedMode?: AttendancePolicy;
  now?: Date;
}

export interface EndActiveSessionOptions {
  root: string;
  roomId: string;
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
    attendance_policy: options.attendancePolicy ?? "manual-ok",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    next_message_id: 1,
    brief_version: 1,
    brief_updated_at: now.toISOString(),
    brief_updated_by: options.hostAlias
  };
  if (options.expiresAt !== undefined) {
    state.expires_at = options.expiresAt.toISOString();
  }

  await writeNewJson(paths.state, state);
  await writeNewJson(paths.participants, []);
  await writeSecureFile(paths.brief, briefBody, { flag: "wx" });
  await writeSecureFile(paths.messages, "", { flag: "wx" });
  return state;
}

export async function updateAttendancePolicy(options: UpdateAttendancePolicyOptions): Promise<RoomState> {
  assertSafeSlug(options.roomId, "room id");
  assertSafeSlug(options.updatedBy, "updated by");
  const now = options.now ?? new Date();
  const paths = roomPaths(options.root, options.roomId);

  return withWriterLock(paths.lock, async () => {
    const state = withRoomDefaults(await readRoomState(paths));
    const updatedState: RoomState = {
      ...state,
      attendance_policy: options.policy,
      updatedAt: now.toISOString()
    };
    await writeJson(paths.state, updatedState);
    return updatedState;
  });
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
    await writeSecureFile(paths.brief, options.body);
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
  return (await appendMessageResult(options)).message;
}

export async function appendMessageResult(options: AppendMessageOptions): Promise<AppendMessageResult> {
  assertSafeSlug(options.roomId, "room id");
  assertSafeSlug(options.from, "from");
  const paths = roomPaths(options.root, options.roomId);
  const input = clientMessageInputFromRecord(options.input);
  const now = options.now ?? new Date();

  return withWriterLock(paths.lock, async () => {
    const state = await readRoomState(paths);
    const participants = await readParticipants(paths);
    const messages = await readJsonLines<Message>(paths.messages);
    if (input.client_msg_id !== undefined) {
      const existing = messages.find(
        (message) => message.from === options.from && message.client_msg_id === input.client_msg_id
      );
      if (existing !== undefined) return { message: existing, idempotent: true };
    }
    if (options.maxMessages !== undefined && messages.length >= options.maxMessages) {
      throw new RoomLogFullError();
    }
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
    return { message, idempotent: false };
  });
}

export async function appendServerMessage(options: AppendServerMessageOptions): Promise<Message> {
  assertSafeSlug(options.roomId, "room id");
  assertSafeSlug(options.from, "from");
  const paths = roomPaths(options.root, options.roomId);
  const now = options.now ?? new Date();

  return withWriterLock(paths.lock, async () => {
    const state = await readRoomState(paths);
    const participants = await readParticipants(paths);
    const message = buildMessage(
      { text: options.text },
      {
        id: state.next_message_id,
        room: state.id,
        from: options.from,
        now,
        mentions: parseMentions(options.text, participants.map((participant) => participant.alias)),
        type: "system"
      }
    );
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

export async function readBrief(root: string, roomId: string): Promise<RoomBrief> {
  const paths = roomPaths(root, roomId);
  const [state, body] = await Promise.all([readRoomState(paths), readFile(paths.brief, "utf8")]);
  return {
    body,
    brief_version: state.brief_version,
    brief_updated_at: state.brief_updated_at,
    brief_updated_by: state.brief_updated_by
  };
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
  await ensureSecureDir(paths.cursors);
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

export async function upsertParticipant(root: string, roomId: string, participant: Participant): Promise<void> {
  assertSafeSlug(participant.alias, "participant alias");
  const paths = roomPaths(root, roomId);
  await withWriterLock(paths.lock, async () => {
    const participants = await readParticipants(paths);
    const existingIndex = participants.findIndex((current) => current.alias === participant.alias);
    if (existingIndex === -1) {
      participants.push(participant);
    } else {
      participants[existingIndex] = participant;
    }
    await writeJson(paths.participants, participants);
  });
}

export async function closeRoom(root: string, roomId: string, now: Date = new Date()): Promise<RoomState> {
  const paths = roomPaths(root, roomId);
  return withWriterLock(paths.lock, async () => {
    const state = await readRoomState(paths);
    // Closing the room clears any active session (T11): state returns to idle.
    const { active_session: _cleared, ...rest } = state;
    const closed = {
      ...rest,
      status: "closed" as const,
      updatedAt: now.toISOString()
    };
    await writeJson(paths.state, closed);
    return closed;
  });
}

// Start the room's single active chat session (T11). Throws
// ActiveSessionExistsError if one is already running (concurrent-start 409).
export async function startActiveSession(options: StartActiveSessionOptions): Promise<ActiveSession> {
  assertSafeSlug(options.roomId, "room id");
  assertSafeSlug(options.startedBy, "started by");
  const now = options.now ?? new Date();
  const paths = roomPaths(options.root, options.roomId);
  return withWriterLock(paths.lock, async () => {
    const state = await readRoomState(paths);
    if (state.active_session !== undefined && state.active_session.ended_at === undefined) {
      throw new ActiveSessionExistsError();
    }
    const session: ActiveSession = {
      channel_id: options.channelId,
      started_at: now.toISOString(),
      expected_duration_m: options.expectedDurationM,
      started_by: options.startedBy
    };
    if (options.requestedMode !== undefined) session.requested_mode = options.requestedMode;
    await writeJson(paths.state, {
      ...state,
      updatedAt: now.toISOString(),
      active_session: session
    });
    return session;
  });
}

// End the active chat session (T11). Returns the ended session (with ended_at
// stamped) or null when none is active; the session is cleared from RoomState so
// /status returns to idle.
export async function endActiveSession(options: EndActiveSessionOptions): Promise<ActiveSession | null> {
  assertSafeSlug(options.roomId, "room id");
  const now = options.now ?? new Date();
  const paths = roomPaths(options.root, options.roomId);
  return withWriterLock(paths.lock, async () => {
    const state = await readRoomState(paths);
    if (state.active_session === undefined || state.active_session.ended_at !== undefined) {
      return null;
    }
    const ended: ActiveSession = { ...state.active_session, ended_at: now.toISOString() };
    const { active_session: _cleared, ...rest } = state;
    await writeJson(paths.state, {
      ...rest,
      updatedAt: now.toISOString()
    });
    return ended;
  });
}

export async function readRoomState(paths: RoomPaths): Promise<RoomState> {
  return withRoomDefaults(await readJson<RoomState>(paths.state));
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
  await ensureSecureDir(paths.root);
  await ensureSecureDir(paths.rooms);
  await ensureSecureDir(paths.room);
  await ensureSecureDir(paths.cursors);
}

function assertBriefSize(body: string): void {
  if (body.length > MAX_BRIEF_LENGTH) {
    throw new Error(`brief body must be <= ${MAX_BRIEF_LENGTH} characters`);
  }
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  await appendSecureFile(path, line);
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeSecureFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function withRoomDefaults(state: RoomState): RoomState {
  return {
    ...state,
    attendance_policy: state.attendance_policy ?? "manual-ok"
  };
}

async function writeNewJson(path: string, value: unknown): Promise<void> {
  await writeSecureFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
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
