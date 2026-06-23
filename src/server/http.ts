import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
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
  updateAttendancePolicy,
  upsertParticipant,
  MAX_BRIEF_LENGTH,
  RoomLogFullError
} from "../storage/index.js";
import type { AttendancePolicy, Participant, RoomBrief } from "../protocol/index.js";
import {
  assertSafeSlug,
  describeAttendancePolicy,
  normalizeBaseUrl,
  parseAttendancePolicy,
  renderAgentInstructions,
  roomUrl
} from "../protocol/index.js";
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
  // Resolves the public base URL advertised in onboarding cards and
  // /wait.next_cmd commands. It is read per request so a tunnel client can
  // publish a broker URL after the server has already started. Request parsing
  // and same-origin checks always use the local `baseUrl`, never this value.
  publicBaseUrl?: () => string;
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
const ATTENDANCE_STALE_AFTER_MS = 90_000;

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
  if (context.req.method === "GET" && pathname === "/room.css") return serveBrowserAsset(context, "room.css", "text/css; charset=utf-8");
  if (context.req.method === "GET" && pathname === "/room.js") return serveBrowserAsset(context, "room.js", "text/javascript; charset=utf-8");
  if (context.req.method === "GET" && pathname === "/brief") return getBrief(context);
  if (context.req.method === "POST" && pathname === "/brief") return postBrief(context);
  if (context.req.method === "POST" && pathname === "/attendance") return postAttendance(context);
  if (context.req.method === "GET" && pathname === "/profile") return getProfile(context);
  if (context.req.method === "POST" && pathname === "/profile") return postProfile(context);
  if (context.req.method === "GET" && pathname === "/card") return getCard(context);
  if (context.req.method === "POST" && pathname === "/join") return postJoin(context);
  if (context.req.method === "GET" && pathname === "/messages") return getMessages(context);
  if (context.req.method === "POST" && pathname === "/messages") return postMessage(context);
  if (context.req.method === "GET" && pathname === "/wait") return getWait(context);
  if (context.req.method === "POST" && pathname === "/leave") return postLeave(context);
  if (context.req.method === "POST" && pathname === "/close") return postClose(context);
  if (context.req.method === "GET" && pathname === "/status") return getStatus(context);
  if (pathname === "/watch") {
    throw new HttpError(404, "not_found", "this server long-polls on GET /wait, not /watch");
  }
  throw new HttpError(404, "not_found", "endpoint not found");
}

async function serveBrowserShell(context: RequestContext): Promise<void> {
  return serveBrowserAsset(context, "room.html", "text/html; charset=utf-8");
}

async function serveBrowserAsset(context: RequestContext, asset: string, contentType: string): Promise<void> {
  const body = await readFile(new URL(`../browser/${asset}`, import.meta.url), "utf8");
  sendText(context.res, 200, body, contentType);
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
  const paths = roomPaths(context.options.root, context.options.roomId);
  const [brief, state] = await Promise.all([
    readBrief(context.options.root, context.options.roomId),
    readRoomState(paths)
  ]);
  sendPlain(
    context.res,
    200,
    renderInviteCard(advertisedBaseUrl(context), auth.participant, auth.token, brief, state.attendance_policy)
  );
}

async function postAttendance(context: RequestContext): Promise<void> {
  const auth = await requireParticipant(context);
  requireHost(auth.participant);
  const body = await readJsonBody<{ policy?: unknown }>(context);
  if (typeof body.policy !== "string") throw new HttpError(400, "invalid_policy", "attendance policy is required");
  let policy: AttendancePolicy;
  try {
    policy = parseAttendancePolicy(body.policy);
  } catch (error) {
    throw new HttpError(400, "invalid_policy", error instanceof Error ? error.message : "invalid attendance policy");
  }
  const state = await updateAttendancePolicy({
    root: context.options.root,
    roomId: context.options.roomId,
    policy,
    updatedBy: auth.participant.alias
  });
  await appendSystem(context, `Attendance policy set to ${policy}`);
  context.options.waitHub.notify(context.options.roomId);
  sendJson(context.res, 200, { ok: true, attendance_policy: state.attendance_policy });
}

async function getProfile(context: RequestContext): Promise<void> {
  const auth = await requireParticipant(context);
  sendJson(context.res, 200, { ok: true, participant: publicParticipant(auth.participant) });
}

async function postProfile(context: RequestContext): Promise<void> {
  const auth = await requireParticipant(context);
  const body = await readJsonBody<{ display_name?: unknown }>(context);
  if (typeof body.display_name !== "string") {
    throw new HttpError(400, "invalid_display_name", "display_name is required");
  }
  const displayName = parseDisplayName(body.display_name);
  const participants = await readParticipants(roomPaths(context.options.root, context.options.roomId));
  const duplicate = participants.find(
    (participant) =>
      participant.alias !== auth.participant.alias &&
      (participant.display_name ?? participant.alias).toLowerCase() === displayName.toLowerCase()
  );
  if (duplicate !== undefined) {
    throw new HttpError(409, "display_name_taken", "display name is already in use");
  }
  const updated: Participant = {
    ...auth.participant,
    display_name: displayName,
    lastSeenAt: new Date().toISOString()
  };
  await upsertParticipant(context.options.root, context.options.roomId, updated);
  sendJson(context.res, 200, { ok: true, participant: publicParticipant(updated) });
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
  const auth = await requireParticipant(context);
  await touchParticipant(context, auth.participant, auth.participant.attention);
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
  await touchParticipant(context, auth.participant, auth.participant.attention);
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
  if (auth.participant.removed_at === undefined) {
    await touchParticipant(context, auth.participant, "attending");
  }
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
      baseUrl: advertisedBaseUrl(context),
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
  const auth = await requireParticipant(context);
  const paths = roomPaths(context.options.root, context.options.roomId);
  const [state, participants] = await Promise.all([readRoomState(paths), readParticipants(paths)]);
  const now = Date.now();
  sendJson(context.res, 200, {
    ok: true,
    room: state.id,
    me: auth.participant.alias,
    is_host: auth.participant.is_host,
    room_status: state.status,
    brief_version: state.brief_version,
    attendance_policy: state.attendance_policy,
    stale_after_ms: ATTENDANCE_STALE_AFTER_MS,
    brief_updated_at: state.brief_updated_at,
    brief_updated_by: state.brief_updated_by,
    participants: participants.map((participant) => publicParticipant(participant, state.attendance_policy, now))
  });
}

type PublicParticipant = Omit<Participant, "token_hash"> & {
  attendance_required: boolean;
  attendance_state: Participant["attention"] | "not_attending" | "stale";
  last_seen_age_ms: number;
  stale_after_ms: number;
};

function publicParticipant(
  participant: Participant,
  attendancePolicy: AttendancePolicy = "manual-ok",
  now = Date.now()
): PublicParticipant {
  const publicFields: Participant = { ...participant };
  delete publicFields.token_hash;
  const lastSeenAt = Date.parse(participant.lastSeenAt);
  const lastSeenAgeMs = Number.isFinite(lastSeenAt) ? Math.max(0, now - lastSeenAt) : Number.MAX_SAFE_INTEGER;
  const attendanceRequired = isForegroundRequired(attendancePolicy, participant);
  const foreground = participant.attention === "attending" || participant.attention === "managed";
  const stale = foreground && lastSeenAgeMs > ATTENDANCE_STALE_AFTER_MS;
  return {
    ...publicFields,
    attendance_required: attendanceRequired,
    attendance_state:
      attendanceRequired && !foreground ? "not_attending" : stale ? "stale" : participant.attention,
    last_seen_age_ms: lastSeenAgeMs,
    stale_after_ms: ATTENDANCE_STALE_AFTER_MS
  };
}

function isForegroundRequired(policy: AttendancePolicy, participant: Participant): boolean {
  if (participant.removed_at !== undefined || participant.kind === "system") return false;
  if (policy === "agents-foreground") return participant.kind === "agent";
  if (policy === "all-foreground") return true;
  return false;
}

async function touchParticipant(
  context: RequestContext,
  participant: Participant,
  attention: Participant["attention"]
): Promise<void> {
  await upsertParticipant(context.options.root, context.options.roomId, {
    ...participant,
    attention,
    lastSeenAt: new Date().toISOString()
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
      baseUrl: advertisedBaseUrl(context),
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

function parseDisplayName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0 || trimmed.length > 60 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new HttpError(
      400,
      "invalid_display_name",
      "display name must be 1-60 characters without control characters"
    );
  }
  return trimmed;
}

export function renderAttendCard(
  baseUrl: string,
  alias: string,
  token: string,
  brief: RoomBrief,
  attendancePolicy: AttendancePolicy = "manual-ok"
): string {
  return [
    `# Agent Gather Attend Card: ${alias}`,
    "",
    "## Room Brief",
    brief.body || "(empty)",
    "",
    "## Attendance Policy",
    `Policy: ${attendancePolicy}`,
    describeAttendancePolicy(attendancePolicy),
    "",
    "## Commands",
    `curl -s "${roomUrl(baseUrl, `/card?participant=${alias}&token=${token}`)}"`,
    `curl -s -X POST "${roomUrl(baseUrl, "/join")}" -H "Authorization: Bearer ${token}"`,
    `curl -s "${roomUrl(baseUrl, `/wait?participant=${alias}&since_id=0`)}" -H "Authorization: Bearer ${token}"`,
    `agentgather attend --json`,
    `curl -s "${roomUrl(baseUrl, "/messages?since_id=0")}" -H "Authorization: Bearer ${token}"`,
    `curl -s -X POST "${roomUrl(baseUrl, "/messages")}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" --data '{"text":"hello"}'`,
    "",
    "## Attendance Recovery",
    "If you run a tool command or shell script, return to foreground attendance immediately after it finishes:",
    "agentgather attend --json",
    "If a shell command contains pipes, quotes, or `${...}`, ask the host for a script file and run one quote-free command such as `bash /path/to/script.sh`.",
    "If the attend loop stops, Agent Gather v0.1 cannot wake this session automatically; the host will see you as stale until you rejoin or attend again.",
    "",
    "## First Action",
    "After joining, send a short ready message so the host and humans can see that you are present.",
    "",
    "## Stop Attending",
    "When the host releases you or the room closes, stop the foreground loop and send a final note if useful.",
    "",
    renderAgentInstructions()
  ].join("\n");
}

export function renderInviteCard(
  baseUrl: string,
  participant: Participant,
  token: string,
  brief: RoomBrief,
  attendancePolicy: AttendancePolicy = "manual-ok"
): string {
  if (participant.kind === "human") {
    return renderHumanInviteCard(baseUrl, participant.alias, token, brief);
  }
  return renderAttendCard(baseUrl, participant.alias, token, brief, attendancePolicy);
}

function renderHumanInviteCard(baseUrl: string, alias: string, token: string, brief: RoomBrief): string {
  return [
    `# Agent Gather Human Invite: ${alias}`,
    "",
    "## Room Brief",
    brief.body || "(empty)",
    "",
    "## Browser Link",
    `${normalizeBaseUrl(baseUrl)}/#token=${token}`,
    "",
    "## What To Do",
    `- Join as @${alias}.`,
    "- Choose a display name if the browser asks for one.",
    "- Read the room goal, participant list, and recent messages.",
    "- Send messages normally from the browser composer.",
    "- If the bare room URL asks for an invite, reopen the Browser Link above.",
    "- If the host is offline, the browser may show cached or exported history until the host resumes."
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

function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/html; charset=utf-8"
): void {
  res.writeHead(status, {
    "content-type": contentType,
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
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_OPTIONS.baseUrl);
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    baseUrl,
    publicBaseUrl: options.publicBaseUrl ?? (() => baseUrl)
  };
}

// Public base URL for onboarding cards and /wait.next_cmd. Falls back to the
// local base URL if the resolver returns an empty or invalid value.
function advertisedBaseUrl(context: RequestContext): string {
  const candidate = context.options.publicBaseUrl();
  if (typeof candidate !== "string" || candidate.length === 0) return context.options.baseUrl;
  try {
    return normalizeBaseUrl(candidate);
  } catch {
    return context.options.baseUrl;
  }
}

export function participantTokenHash(token: string): string {
  return hashToken(token);
}
