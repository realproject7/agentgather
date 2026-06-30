import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { hashToken, verifyToken } from "../auth/index.js";
import {
  addForumComment,
  appendMessageResult,
  appendServerMessage,
  closeRoom,
  createForumPost,
  listForumPosts,
  readBoardroom,
  readBrief,
  readForumPost,
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
import type { AttendancePolicy, Boardroom, Channel, Participant, RoomBrief } from "../protocol/index.js";
import {
  assertSafeSlug,
  DEFAULT_CHANNEL_ID,
  describeAttendancePolicy,
  findNameOwnerConflict,
  negotiateParticipantAttention,
  normalizeBaseUrl,
  normalizeSupportedModes,
  parseAttendancePolicy,
  parseForumStatus,
  renderAgentInstructions,
  renderAttentionGuidance,
  renderForumReviewGuidance,
  roomUrl,
  type AttentionCardInfo,
  type ForumPostStatus
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
  if (context.req.method === "GET" && pathname === "/theme.css") return serveBrowserAsset(context, "theme.css", "text/css; charset=utf-8");
  if (context.req.method === "GET" && pathname === "/kit.css") return serveBrowserAsset(context, "kit.css", "text/css; charset=utf-8");
  if (context.req.method === "GET" && pathname === "/room.js") return serveBrowserAsset(context, "room.js", "text/javascript; charset=utf-8");
  if (context.req.method === "GET" && pathname === "/channel-rail.css") return serveBrowserAsset(context, "channel-rail.css", "text/css; charset=utf-8");
  if (context.req.method === "GET" && pathname === "/channel-rail.js") return serveBrowserAsset(context, "channel-rail.js", "text/javascript; charset=utf-8");
  if (context.req.method === "GET" && pathname === "/markdown.js") return serveBrowserAsset(context, "markdown.js", "text/javascript; charset=utf-8");
  // Forum UI (T8): static assets + a small HTTP surface over the frozen T6 store.
  if (context.req.method === "GET" && pathname === "/forum.html") return serveBrowserAsset(context, "forum.html", "text/html; charset=utf-8");
  if (context.req.method === "GET" && pathname === "/forum.css") return serveBrowserAsset(context, "forum.css", "text/css; charset=utf-8");
  if (context.req.method === "GET" && pathname === "/forum.js") return serveBrowserAsset(context, "forum.js", "text/javascript; charset=utf-8");
  if (context.req.method === "GET" && pathname === "/forum/posts") return getForumPosts(context);
  if (context.req.method === "GET" && pathname === "/forum/post") return getForumPost(context);
  if (context.req.method === "POST" && pathname === "/forum/posts") return postForumPost(context);
  if (context.req.method === "POST" && pathname === "/forum/comment") return postForumComment(context);
  // The room composer imports the shared mention parser so its unknown-mention
  // warning matches the server exactly (same code-fence masking), instead of a
  // browser-only reimplementation.
  if (context.req.method === "GET" && pathname === "/mentions.js") return serveProtocolAsset(context, "mentions.js");
  if (context.req.method === "GET" && pathname === "/validation.js") return serveProtocolAsset(context, "validation.js");
  if (context.req.method === "GET" && pathname === "/manifest.webmanifest") {
    return serveBrowserAsset(context, "manifest.webmanifest", "application/manifest+json; charset=utf-8");
  }
  if (context.req.method === "GET" && (pathname === "/agentgather-logo.png" || pathname === "/favicon.png")) {
    return serveBrowserBinaryAsset(context, "agentgather-logo.png", "image/png");
  }
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
  if (context.req.method === "GET" && pathname === "/boardroom") return getBoardroom(context);
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

// Serve a compiled protocol module the browser imports directly (mention
// parser). These are pure, dependency-light ES modules with no Node APIs.
async function serveProtocolAsset(context: RequestContext, asset: string): Promise<void> {
  const body = await readFile(new URL(`../protocol/${asset}`, import.meta.url), "utf8");
  sendText(context.res, 200, body, "text/javascript; charset=utf-8");
}

async function serveBrowserBinaryAsset(context: RequestContext, asset: string, contentType: string): Promise<void> {
  const body = await readFile(new URL(`../browser/${asset}`, import.meta.url));
  context.res.writeHead(200, { "content-type": contentType, "content-length": body.byteLength });
  context.res.end(body);
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
  const body = await readJsonBody<{
    display_name?: unknown;
    supported_modes?: unknown;
    poll_cadence_s?: unknown;
    safety_wake_s?: unknown;
  }>(context);
  if (typeof body.display_name !== "string") {
    throw new HttpError(400, "invalid_display_name", "display_name is required");
  }
  const displayName = parseDisplayName(body.display_name);
  const participants = await readParticipants(roomPaths(context.options.root, context.options.roomId));
  // Name ownership (T7): a name is reclaimable only by its owning token; a
  // duplicate name presented under a different token is rejected.
  const conflict = findNameOwnerConflict(participants, displayName, {
    alias: auth.participant.alias,
    ...(auth.participant.token_hash === undefined ? {} : { tokenHash: auth.participant.token_hash })
  });
  if (conflict !== undefined) {
    throw new HttpError(409, "display_name_taken", "display name is already in use");
  }
  // 9A: a participant may declare its supported attention modes + advisory
  // cadences here. requested_mode is the host's (set on invite), never declared
  // by the participant. effective_mode is server-negotiated below.
  const declared = parseAttentionDeclaration(body);
  const updated: Participant = withNegotiatedAttention({
    ...auth.participant,
    ...declared,
    display_name: displayName,
    lastSeenAt: new Date().toISOString()
  });
  await upsertParticipant(context.options.root, context.options.roomId, updated);
  sendJson(context.res, 200, { ok: true, participant: publicParticipant(updated) });
}

async function postJoin(context: RequestContext): Promise<void> {
  const auth = await requireParticipant(context);
  const now = new Date().toISOString();
  const { removed_at: _removedAt, ...baseParticipant } = auth.participant;
  // 9A: a participant may declare its supported attention modes + advisory
  // cadences on join; persist the declaration, then negotiate effective_mode
  // from it and the host's requested_mode. An empty body re-negotiates from the
  // already-stored declaration (a plain reconnect), unchanged.
  const declared = parseAttentionDeclaration(
    await readJsonBody<{ supported_modes?: unknown; poll_cadence_s?: unknown; safety_wake_s?: unknown }>(context)
  );
  const participant: Participant = withNegotiatedAttention({
    ...baseParticipant,
    ...declared,
    attention: "attending",
    joinedAt: baseParticipant.joinedAt || now,
    lastSeenAt: now
  });
  await upsertParticipant(context.options.root, context.options.roomId, participant);
  await appendSystem(context, `${auth.participant.alias} joined`);
  context.options.waitHub.notify(context.options.roomId);
  sendJson(context.res, 200, { ok: true, participant: auth.participant.alias });
}

// ---- Forum HTTP surface (T8) over the frozen T6 store ----
async function getForumPosts(context: RequestContext): Promise<void> {
  await requireParticipant(context);
  const channel = requireForumChannelParam(context);
  const posts = await forumGuard(() => listForumPosts(context.options.root, context.options.roomId, channel));
  // comment_count is a derived, response-only field (NOT part of the frozen
  // ForumPost on disk) so the list row can show it without an extra round-trip.
  const withCounts = await Promise.all(
    posts.map(async (post) => {
      const thread = await readForumPost(context.options.root, context.options.roomId, channel, post.id);
      return { ...post, comment_count: thread.comments.length };
    })
  );
  sendJson(context.res, 200, { ok: true, channel, posts: withCounts });
}

async function getForumPost(context: RequestContext): Promise<void> {
  await requireParticipant(context);
  const channel = requireForumChannelParam(context);
  const post = requireParam(context, "post");
  const thread = await forumGuard(() => readForumPost(context.options.root, context.options.roomId, channel, post));
  sendJson(context.res, 200, { ok: true, ...thread });
}

async function postForumPost(context: RequestContext): Promise<void> {
  const auth = await requireParticipant(context);
  await requireRoomOpen(context);
  const body = await readJsonBody<{ channel?: unknown; title?: unknown; body?: unknown; tags?: unknown; status?: unknown }>(context);
  if (typeof body.channel !== "string" || typeof body.title !== "string" || typeof body.body !== "string") {
    throw new HttpError(400, "invalid_forum_post", "channel, title, and body are required");
  }
  const input: { author: string; title: string; body: string; tags?: string[]; status?: ForumPostStatus } = {
    author: auth.participant.alias,
    title: body.title,
    body: body.body
  };
  if (Array.isArray(body.tags)) input.tags = body.tags.filter((t): t is string => typeof t === "string");
  if (typeof body.status === "string") input.status = parseForumStatus(body.status);
  const post = await forumGuard(() => createForumPost(context.options.root, context.options.roomId, body.channel as string, input));
  sendJson(context.res, 201, { ok: true, post });
}

async function postForumComment(context: RequestContext): Promise<void> {
  const auth = await requireParticipant(context);
  await requireRoomOpen(context);
  const body = await readJsonBody<{ channel?: unknown; post?: unknown; body?: unknown }>(context);
  if (typeof body.channel !== "string" || typeof body.post !== "string" || typeof body.body !== "string") {
    throw new HttpError(400, "invalid_forum_comment", "channel, post, and body are required");
  }
  if (body.body.trim().length === 0) throw new HttpError(400, "invalid_forum_comment", "comment body is required");
  const comment = await forumGuard(() =>
    addForumComment(context.options.root, context.options.roomId, body.channel as string, body.post as string, {
      author: auth.participant.alias,
      body: body.body as string
    })
  );
  sendJson(context.res, 201, { ok: true, comment });
}

function requireParam(context: RequestContext, name: string): string {
  const value = context.url.searchParams.get(name);
  if (value === null || value.length === 0) throw new HttpError(400, "missing_param", `${name} is required`);
  return value;
}

function requireForumChannelParam(context: RequestContext): string {
  return requireParam(context, "channel");
}

// Map forum-store validation/not-found errors to HTTP errors instead of 500.
async function forumGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = error instanceof Error ? error.message : "forum error";
    const notFound = /not found/i.test(message) || (error instanceof Error && "code" in error && error.code === "ENOENT");
    if (notFound) throw new HttpError(404, "forum_not_found", "forum post not found");
    throw new HttpError(400, "forum_error", message);
  }
}

// Apply the negotiated supported/requested/effective attention modes (9A).
function withNegotiatedAttention(participant: Participant): Participant {
  return { ...participant, ...negotiateParticipantAttention(participant) };
}

function parseAttentionDeclaration(body: {
  supported_modes?: unknown;
  poll_cadence_s?: unknown;
  safety_wake_s?: unknown;
}): Partial<Pick<Participant, "supported_modes" | "poll_cadence_s" | "safety_wake_s">> {
  const out: Partial<Pick<Participant, "supported_modes" | "poll_cadence_s" | "safety_wake_s">> = {};
  if (body.supported_modes !== undefined) {
    if (!Array.isArray(body.supported_modes) || body.supported_modes.some((m) => typeof m !== "string")) {
      throw new HttpError(400, "invalid_supported_modes", "supported_modes must be an array of mode strings");
    }
    try {
      out.supported_modes = normalizeSupportedModes(body.supported_modes as string[]);
    } catch (error) {
      throw new HttpError(400, "invalid_supported_modes", error instanceof Error ? error.message : "invalid supported_modes");
    }
  }
  if (body.poll_cadence_s !== undefined) out.poll_cadence_s = parsePositiveSeconds(body.poll_cadence_s, "poll_cadence_s");
  if (body.safety_wake_s !== undefined) out.safety_wake_s = parsePositiveSeconds(body.safety_wake_s, "safety_wake_s");
  return out;
}

function parsePositiveSeconds(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, "invalid_cadence", `${label} must be a positive number of seconds`);
  }
  return value;
}

async function getMessages(context: RequestContext): Promise<void> {
  const auth = await requireParticipant(context);
  // Channel boundary (V2 #167): only the default #general chat channel is backed
  // by the room-wide log in this version. A `channel` param for any other chat
  // channel is rejected with a clear 400 rather than silently returning the
  // room-wide log (which would misrepresent an unsupported channel). No `channel`
  // param (legacy clients) and `channel=general` keep the existing behavior.
  const channel = context.url.searchParams.get("channel");
  if (channel !== null && channel !== DEFAULT_CHANNEL_ID) {
    throw new HttpError(
      400,
      "unsupported_channel",
      `channel-scoped chat is not available; only #${DEFAULT_CHANNEL_ID} carries chat in this version`
    );
  }
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
  const [state, participants, boardroom] = await Promise.all([
    readRoomState(paths),
    readParticipants(paths),
    readBoardroom(context.options.root, context.options.roomId)
  ]);
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
    boardroom: publicBoardroom(boardroom),
    participants: participants.map((participant) => publicParticipant(participant, state.attendance_policy, now))
  });
}

// Expose boardroom + channel metadata over HTTP (V2 Ticket A). Reuses the
// host-owned `readBoardroom` projection — a legacy bare room surfaces as a
// single #general chat channel at runtime with no migration.
async function getBoardroom(context: RequestContext): Promise<void> {
  await requireParticipant(context);
  const boardroom = await readBoardroom(context.options.root, context.options.roomId);
  sendJson(context.res, 200, { ok: true, boardroom: publicBoardroom(boardroom) });
}

type PublicChannel = Pick<Channel, "id" | "name" | "type" | "lifecycle" | "createdAt">;
type PublicBoardroom = Pick<Boardroom, "id" | "lifecycle" | "legacy" | "createdAt" | "updatedAt"> & {
  name?: string;
  channels: PublicChannel[];
};

// Metadata-only projection of the host-owned boardroom for the HTTP surface.
// Deliberately enumerates the boardroom/channel metadata fields so the privacy
// gate is provable: never raw tokens, invite URLs, or message bodies. The
// host-owned files remain the single source of truth.
function publicBoardroom(boardroom: Boardroom): PublicBoardroom {
  const out: PublicBoardroom = {
    id: boardroom.id,
    lifecycle: boardroom.lifecycle,
    legacy: boardroom.legacy,
    createdAt: boardroom.createdAt,
    updatedAt: boardroom.updatedAt,
    channels: boardroom.channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      lifecycle: channel.lifecycle,
      createdAt: channel.createdAt
    }))
  };
  if (boardroom.name !== undefined) out.name = boardroom.name;
  return out;
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
  attendancePolicy: AttendancePolicy = "manual-ok",
  attention: AttentionCardInfo = {},
  forumReviewChannel?: string
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
    renderAttentionGuidance(attention),
    "",
    "## Commands",
    `curl -s "${roomUrl(baseUrl, `/card?participant=${alias}&token=${token}`)}"`,
    `curl -s -X POST "${roomUrl(baseUrl, "/join")}" -H "Authorization: Bearer ${token}"`,
    `curl -s "${roomUrl(baseUrl, `/wait?participant=${alias}&since_id=0`)}" -H "Authorization: Bearer ${token}"`,
    `agentgather attend --json`,
    `curl -s "${roomUrl(baseUrl, "/messages?since_id=0")}" -H "Authorization: Bearer ${token}"`,
    `curl -s -X POST "${roomUrl(baseUrl, "/messages")}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" --data '{"text":"hello"}'`,
    "",
    ...(forumReviewChannel === undefined ? [] : forumReviewSection(baseUrl, token, forumReviewChannel)),
    ...attendanceRecovery(forumReviewChannel !== undefined),
    "",
    "## First Action",
    "After joining, send a short ready message so the host and humans can see that you are present.",
    "",
    "## Stop Attending",
    forumReviewChannel === undefined
      ? "When the host releases you or the room closes, stop the foreground loop and send a final note if useful."
      : "When the host marks the task resolved or the room closes, stop watching and send a final note if useful.",
    "",
    renderAgentInstructions()
  ].join("\n");
}

// Recovery guidance. A forum-review (async) card must NOT force a foreground loop
// or deny wake-on-event; it returns to the agent's declared mode and reflects the
// 9B contract (honest manual fallback) instead.
function attendanceRecovery(forumReview: boolean): string[] {
  if (forumReview) {
    return [
      "## Attendance Recovery",
      "This is an async forum-review task — you do NOT need to hold a foreground attend loop.",
      "After running a command, return to your declared attention mode: wake-on-event / cheap watching if your harness supports it, otherwise `manual`.",
      "If a shell command contains pipes, quotes, or `${...}`, ask the host for a script file and run one quote-free command such as `bash /path/to/script.sh`.",
      "Per your declared mode, the next assigned/updated post reaches you as an actionable `/wait` return; empty polls do not invoke the model. If you declared `manual`, a human relays — Agent Gather does not wake a detached session on its own."
    ];
  }
  return [
    "## Attendance Recovery",
    "If you run a tool command or shell script, return to foreground attendance immediately after it finishes:",
    "agentgather attend --json",
    "If a shell command contains pipes, quotes, or `${...}`, ask the host for a script file and run one quote-free command such as `bash /path/to/script.sh`.",
    "If the attend loop stops, Agent Gather v0.1 cannot wake this session automatically; the host will see you as stale until you rejoin or attend again."
  ];
}

// Forum review task block (T10): the 9B wake-on-event guidance + copy-pastable
// commands against the real T6 forum endpoints. The token appears exactly once
// (in the env export); the curls reference $AG_TOKEN so it is not repeated.
function forumReviewSection(baseUrl: string, token: string, channel: string): string[] {
  const base = normalizeBaseUrl(baseUrl);
  return [
    renderForumReviewGuidance(channel),
    "",
    "Forum commands (set these once; the token appears only here):",
    `export AG_BASE='${base}' AG_TOKEN='${token}'`,
    "# check assigned/updated forum posts",
    `curl -s "$AG_BASE/forum/posts?channel=${channel}" -H "Authorization: Bearer $AG_TOKEN"`,
    "# read a post + its comments (replace POST_ID)",
    `curl -s "$AG_BASE/forum/post?channel=${channel}&post=POST_ID" -H "Authorization: Bearer $AG_TOKEN"`,
    "# post a comment / reply (replace POST_ID and the body)",
    `curl -s -X POST "$AG_BASE/forum/comment" -H "Authorization: Bearer $AG_TOKEN" -H "Content-Type: application/json" --data '{"channel":"${channel}","post":"POST_ID","body":"your reply"}'`,
    "Then go idle — wake on the next assigned/updated post; no foreground loop required.",
    ""
  ];
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
  const attention: AttentionCardInfo = {};
  if (participant.requested_mode !== undefined) attention.requested_mode = participant.requested_mode;
  if (participant.effective_mode !== undefined) attention.effective_mode = participant.effective_mode;
  if (participant.poll_cadence_s !== undefined) attention.poll_cadence_s = participant.poll_cadence_s;
  if (participant.safety_wake_s !== undefined) attention.safety_wake_s = participant.safety_wake_s;
  return renderAttendCard(baseUrl, participant.alias, token, brief, attendancePolicy, attention, participant.forum_review_channel);
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
