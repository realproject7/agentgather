import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { hashToken, verifyToken } from "../auth/index.js";
import {
  appendMessageResult,
  appendServerMessage,
  closeRoom,
  readBrief,
  readMessages,
  readParticipants,
  readRoomState,
  roomPaths,
  updateBrief,
  upsertParticipant,
  MAX_BRIEF_LENGTH,
  RoomLogFullError
} from "../storage/index.js";
import type { Participant, RoomBrief } from "../protocol/index.js";
import { assertSafeSlug, renderAgentInstructions } from "../protocol/index.js";
import { errorBody, HttpError } from "./errors.js";
import { buildWaitResponse, defaultWaitHub, type WaitHub } from "./wait.js";

export interface RoomHttpServerOptions {
  root: string;
  roomId: string;
  baseUrl?: string;
  maxBodyBytes?: number;
  maxMessages?: number;
  rateLimitPerMinute?: number;
  loopGuardLimit?: number;
  waitHoldMs?: number;
  waitHub?: WaitHub;
  allowInsecureRemote?: boolean;
}

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  options: Required<RoomHttpServerOptions>;
}

interface AuthenticatedParticipant {
  participant: Participant;
  token: string;
}

const DEFAULT_OPTIONS = {
  baseUrl: "http://127.0.0.1:8787",
  maxBodyBytes: 64_000,
  maxMessages: 50_000,
  rateLimitPerMinute: 120,
  loopGuardLimit: 30,
  waitHoldMs: 25_000,
  waitHub: defaultWaitHub,
  allowInsecureRemote: false
};

const rateBuckets = new Map<string, { resetAt: number; count: number }>();
const loopCounts = new Map<string, number>();

export function createRoomHttpServer(options: RoomHttpServerOptions): Server {
  const resolved = resolveOptions(options);
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", resolved.baseUrl);
    void handleRequest({ req, res, url, options: resolved }).catch((error: unknown) => {
      sendError(res, error);
    });
  });
}

async function handleRequest(context: RequestContext): Promise<void> {
  enforceExposure(context);
  if (isWriteMethod(context.req.method)) enforceSameOrigin(context);

  const { pathname } = context.url;
  if (context.req.method === "GET" && pathname === "/") return serveBrowserShell(context);
  if (context.req.method === "GET" && pathname === "/brief") return getBrief(context);
  if (context.req.method === "POST" && pathname === "/brief") return postBrief(context);
  if (context.req.method === "GET" && pathname === "/card") return getCard(context);
  if (context.req.method === "POST" && pathname === "/join") return postJoin(context);
  if (context.req.method === "GET" && pathname === "/messages") return getMessages(context);
  if (context.req.method === "POST" && pathname === "/messages") return postMessage(context);
  if (context.req.method === "GET" && pathname === "/wait") return getWait(context);
  if (context.req.method === "POST" && pathname === "/leave") return postLeave(context);
  if (context.req.method === "POST" && pathname === "/close") return postClose(context);
  if (context.req.method === "GET" && pathname === "/status") return getStatus(context);
  throw new HttpError(404, "not_found", "endpoint not found");
}

async function serveBrowserShell(context: RequestContext): Promise<void> {
  sendText(
    context.res,
    200,
    [
      "<!doctype html>",
      "<meta charset=\"utf-8\">",
      "<title>Telegent Room</title>",
      "<main id=\"telegent-room\">",
      "<header><h1>Telegent Room</h1></header>",
      "<section id=\"telegent-timeline\" aria-live=\"polite\"></section>",
      "<form id=\"telegent-composer\"><textarea name=\"text\"></textarea><button>Send</button></form>",
      "</main>"
    ].join("")
  );
}

async function getBrief(context: RequestContext): Promise<void> {
  await requireParticipant(context);
  sendJson(context.res, 200, { ok: true, brief: await readBrief(context.options.root, context.options.roomId) });
}

async function postBrief(context: RequestContext): Promise<void> {
  const auth = await requireParticipant(context);
  requireHost(auth.participant);
  const body = await readJsonBody<{ body?: unknown }>(context);
  if (typeof body.body !== "string") throw new HttpError(400, "invalid_body", "brief body is required");
  if (body.body.length > MAX_BRIEF_LENGTH) {
    throw new HttpError(413, "brief_too_large", `brief body must be <= ${MAX_BRIEF_LENGTH} characters`);
  }
  const brief = await updateBrief({
    root: context.options.root,
    roomId: context.options.roomId,
    body: body.body,
    updatedBy: auth.participant.alias
  });
  await appendSystem(context, `Room brief updated to v${brief.brief_version}`);
  context.options.waitHub.notify(context.options.roomId);
  sendJson(context.res, 200, { ok: true, brief });
}

async function getCard(context: RequestContext): Promise<void> {
  const auth = await requireParticipant(context, { allowQueryToken: true });
  const brief = await readBrief(context.options.root, context.options.roomId);
  sendPlain(context.res, 200, renderAttendCard(context.options.baseUrl, auth.participant.alias, auth.token, brief));
}

async function postJoin(context: RequestContext): Promise<void> {
  const auth = await requireParticipant(context);
  const now = new Date().toISOString();
  const { removed_at: _removedAt, ...baseParticipant } = auth.participant;
  const participant: Participant = {
    ...baseParticipant,
    attention: "attending",
    joinedAt: baseParticipant.joinedAt || now,
    lastSeenAt: now
  };
  await upsertParticipant(context.options.root, context.options.roomId, participant);
  await appendSystem(context, `${auth.participant.alias} joined`);
  context.options.waitHub.notify(context.options.roomId);
  sendJson(context.res, 200, { ok: true, participant: auth.participant.alias });
}

async function getMessages(context: RequestContext): Promise<void> {
  await requireParticipant(context);
  const sinceId = parseSinceId(context.url.searchParams.get("since_id"));
  const messages = (await readMessages(context.options.root, context.options.roomId)).filter(
    (message) => message.id > sinceId
  );
  sendJson(context.res, 200, {
    ok: true,
    messages,
    next_since_id: messages.at(-1)?.id ?? sinceId
  });
}

async function postMessage(context: RequestContext): Promise<void> {
  const auth = await requireParticipant(context);
  const body = await readJsonBody<unknown>(context);
  await requireRoomOpen(context);
  enforceRateLimit(`${context.options.roomId}:${auth.participant.alias}`, context.options.rateLimitPerMinute);
  enforceLoopGuard(context.options.roomId, auth.participant, context.options.loopGuardLimit);
  const result = await appendMessageResult({
    root: context.options.root,
    roomId: context.options.roomId,
    from: auth.participant.alias,
    input: body,
    maxMessages: context.options.maxMessages
  });
  if (result.idempotent) {
    sendJson(context.res, 200, { ok: true, message: result.message, idempotent: true });
    return;
  }
  context.options.waitHub.notify(context.options.roomId);
  sendJson(context.res, 201, { ok: true, message: result.message });
}

async function getWait(context: RequestContext): Promise<void> {
  const auth = await requireParticipant(context, { allowRemoved: true });
  const sinceId = parseSinceId(context.url.searchParams.get("since_id"));
  const participantParam = context.url.searchParams.get("participant");
  if (participantParam !== null && participantParam !== auth.participant.alias) {
    throw new HttpError(403, "participant_mismatch", "participant query does not match token");
  }
  if (auth.participant.removed_at !== undefined) {
    const state = await closeExpiredRoomIfNeeded(context);
    sendJson(context.res, 200, {
      ok: true,
      room: context.options.roomId,
      room_status: state.status,
      participant: auth.participant.alias,
      participant_status: "removed",
      heartbeat: false,
      messages: [],
      mentioned: false,
      next_since_id: sinceId,
      keep_waiting: false,
      next_cmd: null
    });
    return;
  }

  const immediate = await waitSnapshot(context, auth.participant.alias, sinceId);
  if (immediate !== null) {
    sendJson(context.res, 200, immediate);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.options.waitHoldMs);
  try {
    await context.options.waitHub.wait(context.options.roomId, controller.signal);
  } finally {
    clearTimeout(timer);
  }

  const afterWait = await waitSnapshot(context, auth.participant.alias, sinceId);
  if (afterWait !== null) {
    sendJson(context.res, 200, afterWait);
    return;
  }

  sendJson(
    context.res,
    200,
    buildWaitResponse({
      room: context.options.roomId,
      roomStatus: "open",
      participant: auth.participant.alias,
      messages: [],
      sinceId,
      baseUrl: context.options.baseUrl,
      heartbeat: true,
      keepWaiting: true
    })
  );
}

async function postLeave(context: RequestContext): Promise<void> {
  const auth = await requireParticipant(context);
  await upsertParticipant(context.options.root, context.options.roomId, {
    ...auth.participant,
    attention: "away",
    lastSeenAt: new Date().toISOString()
  });
  await appendSystem(context, `${auth.participant.alias} left`);
  context.options.waitHub.notify(context.options.roomId);
  sendJson(context.res, 200, { ok: true });
}

async function postClose(context: RequestContext): Promise<void> {
  const auth = await requireParticipant(context);
  requireHost(auth.participant);
  const state = await closeRoom(context.options.root, context.options.roomId);
  await appendSystem(context, "room closed");
  context.options.waitHub.notify(context.options.roomId);
  sendJson(context.res, 200, { ok: true, room_status: state.status });
}

async function getStatus(context: RequestContext): Promise<void> {
  await requireParticipant(context);
  const paths = roomPaths(context.options.root, context.options.roomId);
  const [state, participants] = await Promise.all([readRoomState(paths), readParticipants(paths)]);
  sendJson(context.res, 200, {
    ok: true,
    room: state.id,
    room_status: state.status,
    brief_version: state.brief_version,
    brief_updated_at: state.brief_updated_at,
    brief_updated_by: state.brief_updated_by,
    participants: participants.map(({ token_hash, ...participant }) => participant)
  });
}

async function requireParticipant(
  context: RequestContext,
  options: { allowQueryToken?: boolean; allowRemoved?: boolean } = {}
): Promise<AuthenticatedParticipant> {
  const token = bearerToken(context.req) ?? (options.allowQueryToken ? context.url.searchParams.get("token") : null);
  if (token === null) throw new HttpError(401, "unauthorized", "bearer token is required");
  const paths = roomPaths(context.options.root, context.options.roomId);
  const participants = await readParticipants(paths);
  const participant = participants.find(
    (candidate) => candidate.token_hash !== undefined && verifyToken(token, candidate.token_hash)
  );
  if (participant === undefined || (participant.removed_at !== undefined && !options.allowRemoved)) {
    throw new HttpError(403, "forbidden", "participant token is not allowed");
  }
  return { participant, token };
}

async function waitSnapshot(
  context: RequestContext,
  participant: string,
  sinceId: number
): Promise<ReturnType<typeof buildWaitResponse> | null> {
  const state = await closeExpiredRoomIfNeeded(context);
  if (state.status === "closed") {
    return buildWaitResponse({
      room: context.options.roomId,
      roomStatus: "closed",
      participant,
      messages: [],
      sinceId,
      baseUrl: context.options.baseUrl,
      heartbeat: false,
      keepWaiting: false
    });
  }
  const messages = (await readMessages(context.options.root, context.options.roomId)).filter(
    (message) => message.id > sinceId
  );
  if (messages.length === 0) return null;
  return buildWaitResponse({
    room: context.options.roomId,
    roomStatus: "open",
    participant,
    messages,
    sinceId,
    baseUrl: context.options.baseUrl,
    heartbeat: false,
    keepWaiting: false
  });
}

function requireHost(participant: Participant): void {
  if (!participant.is_host) throw new HttpError(403, "host_required", "host access is required");
}

async function requireRoomOpen(context: RequestContext): Promise<void> {
  const state = await closeExpiredRoomIfNeeded(context);
  if (state.status !== "open") {
    throw new HttpError(403, "room_closed", "room is closed");
  }
}

async function closeExpiredRoomIfNeeded(context: RequestContext): Promise<Awaited<ReturnType<typeof readRoomState>>> {
  const paths = roomPaths(context.options.root, context.options.roomId);
  const state = await readRoomState(paths);
  if (state.status === "open" && state.expires_at !== undefined && Date.now() >= Date.parse(state.expires_at)) {
    const closed = await closeRoom(context.options.root, context.options.roomId);
    await appendSystem(context, "room closed by ttl");
    context.options.waitHub.notify(context.options.roomId);
    return closed;
  }
  return state;
}

async function appendSystem(context: RequestContext, text: string): Promise<void> {
  await appendServerMessage({
    root: context.options.root,
    roomId: context.options.roomId,
    from: "system",
    text
  });
}

async function readJsonBody<T>(context: RequestContext): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of context.req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > context.options.maxBodyBytes) {
      throw new HttpError(413, "body_too_large", "request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "request body must be valid JSON");
  }
}

function enforceRateLimit(alias: string, limit: number): void {
  const now = Date.now();
  const bucket = rateBuckets.get(alias);
  if (bucket === undefined || now >= bucket.resetAt) {
    rateBuckets.set(alias, { resetAt: now + 60_000, count: 1 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) throw new HttpError(429, "rate_limited", "rate limit exceeded");
}

function enforceLoopGuard(roomId: string, participant: Participant, limit: number): void {
  if (participant.kind === "human") {
    for (const key of loopCounts.keys()) {
      if (key.startsWith(`${roomId}:`)) loopCounts.delete(key);
    }
    return;
  }
  const key = `${roomId}:${participant.alias}`;
  const next = (loopCounts.get(key) ?? 0) + 1;
  loopCounts.set(key, next);
  if (next > limit) throw new HttpError(429, "loop_guard", "loop guard stopped repeated agent messages");
}

function enforceExposure(context: RequestContext): void {
  if (context.options.allowInsecureRemote) return;
  const host = context.req.headers.host ?? "";
  if (isLocalhost(host)) return;
  throw new HttpError(403, "insecure_remote", "plain HTTP exposure beyond localhost is not allowed");
}

function enforceSameOrigin(context: RequestContext): void {
  const origin = context.req.headers.origin;
  const referer = context.req.headers.referer;
  const expected = new URL(context.options.baseUrl).origin;
  if (typeof origin === "string" && origin !== expected) {
    throw new HttpError(403, "bad_origin", "origin is not allowed");
  }
  if (typeof referer === "string") {
    try {
      if (new URL(referer).origin !== expected) {
        throw new HttpError(403, "bad_referer", "referer is not allowed");
      }
    } catch {
      throw new HttpError(403, "bad_referer", "referer is not allowed");
    }
  }
}

function isLocalhost(hostHeader: string): boolean {
  const host = hostHeader.split(":")[0] ?? "";
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function isWriteMethod(method: string | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function bearerToken(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer (.+)$/.exec(authorization);
  return match?.[1] ?? null;
}

function parseSinceId(raw: string | null): number {
  if (raw === null) return 0;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(400, "invalid_since_id", "since_id must be a non-negative integer");
  }
  return parsed;
}

export function renderAttendCard(baseUrl: string, alias: string, token: string, brief: RoomBrief): string {
  return [
    `# Telegent Attend Card: ${alias}`,
    "",
    "## Room Brief",
    brief.body || "(empty)",
    "",
    "## Commands",
    `curl -s "${baseUrl}/card?participant=${alias}&token=${token}"`,
    `curl -s -X POST "${baseUrl}/join" -H "Authorization: Bearer ${token}"`,
    `curl -s "${baseUrl}/wait?participant=${alias}&since_id=0" -H "Authorization: Bearer ${token}"`,
    `curl -s "${baseUrl}/messages?since_id=0" -H "Authorization: Bearer ${token}"`,
    `curl -s -X POST "${baseUrl}/messages" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" --data '{"text":"hello"}'`,
    "",
    renderAgentInstructions()
  ].join("\n");
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendPlain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res: ServerResponse, error: unknown): void {
  const httpError =
    error instanceof HttpError
      ? error
      : error instanceof RoomLogFullError
        ? new HttpError(507, "room_log_full", error.message)
      : new HttpError(500, "internal_error", error instanceof Error ? error.message : "internal error");
  sendJson(res, httpError.status, errorBody(httpError.code, httpError.message));
}

function resolveOptions(options: RoomHttpServerOptions): Required<RoomHttpServerOptions> {
  assertSafeSlug(options.roomId, "room id");
  return {
    ...DEFAULT_OPTIONS,
    ...options
  };
}

export function participantTokenHash(token: string): string {
  return hashToken(token);
}
