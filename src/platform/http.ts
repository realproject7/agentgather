// Control plane HTTP surface for the owner browser shell.
//
// Serves the owner shell static assets and the read-only platform API the shell
// consumes: room list/status from the #80/#81 control-plane handlers, and a
// chat read that surfaces the host-owned message log live (never stored
// centrally). It is bound to localhost and scoped to a single configured owner;
// production login/provider setup remains an operator gate.
//
// The shell's two data sources stay separate here: registry/status comes from
// the platform handlers, while the chat pane reads the existing host-owned room
// message log via the same storage the room server uses.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { readJoinedRooms, recordJoinedRoom, readMessages } from "../storage/index.js";
import { devOwnerIdentityFromEnv, type DevOwnerIdentityConfig, type PlatformOwnerQuery } from "./accounts.js";
import { listRoomsResponse, readRoomResponse } from "./api.js";

export interface PlatformHttpServerOptions {
  /** Home directory holding the control-plane registry and host room logs. */
  root: string;
  /** Owner the shell is scoped to. Kept for existing local callers. */
  ownerUserId?: string;
  /** Configurable local/dogfood owner identity. Production auth is a later gate. */
  devOwner?: DevOwnerIdentityConfig;
  /** Allow non-localhost Host headers. Off by default to avoid open exposure. */
  allowInsecureRemote?: boolean;
}

const ASSETS: Record<string, { file: string; contentType: string }> = {
  "/": { file: "shell.html", contentType: "text/html; charset=utf-8" },
  "/shell.css": { file: "shell.css", contentType: "text/css; charset=utf-8" },
  "/theme.css": { file: "theme.css", contentType: "text/css; charset=utf-8" },
  "/shell.js": { file: "shell.js", contentType: "text/javascript; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", contentType: "application/manifest+json; charset=utf-8" },
  "/agentgather-logo.png": { file: "agentgather-logo.png", contentType: "image/png" },
  "/favicon.png": { file: "agentgather-logo.png", contentType: "image/png" }
};

/** Create the owner control-plane HTTP server. */
export function createPlatformHttpServer(options: PlatformHttpServerOptions): Server {
  return createServer((req, res) => {
    void handle(options, req, res).catch(() => sendJson(res, 500, { ok: false, error: "internal_error" }));
  });
}

async function handle(options: PlatformHttpServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (options.allowInsecureRemote !== true && !isLocalhost(req.headers.host)) {
    sendJson(res, 403, { ok: false, error: "insecure_remote", message: "platform shell is localhost-only" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://platform.local");
  // Same-device bridge (#178): a browser room join (different origin, localStorage
  // is origin-scoped) POSTs its token-free metadata here so it appears in the
  // owner dashboard's "Rooms I'm in" alongside CLI joins. Localhost-only (the gate
  // above), metadata-only (the handler strips anything token-like) — the one write
  // on this otherwise read-only surface.
  if (req.method === "POST" && url.pathname === "/joined-rooms") {
    await recordJoinedRoomFromRequest(options, req, res);
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "read-only surface" });
    return;
  }

  const asset = ASSETS[url.pathname];
  if (asset !== undefined) {
    await sendAsset(res, asset.file, asset.contentType);
    return;
  }

  const query = ownerQuery(options);
  if (url.pathname === "/rooms") {
    const result = await listRoomsResponse(options.root, query);
    sendJson(res, result.status, result.body);
    return;
  }

  // "Rooms I'm in" (#178): device-local joined-room metadata (never a token), with
  // honest, token-free reachability probed live per request. No central copy.
  if (url.pathname === "/joined-rooms") {
    await sendJoinedRooms(options, res);
    return;
  }

  const messagesMatch = /^\/rooms\/([^/]+)\/messages$/.exec(url.pathname);
  if (messagesMatch !== null) {
    await sendRoomMessages(options, decodeURIComponent(messagesMatch[1] ?? ""), url, res);
    return;
  }

  const roomMatch = /^\/rooms\/([^/]+)$/.exec(url.pathname);
  if (roomMatch !== null) {
    const result = await readRoomResponse(options.root, decodeURIComponent(roomMatch[1] ?? ""), query);
    sendJson(res, result.status, result.body);
    return;
  }

  sendJson(res, 404, { ok: false, error: "not_found", message: "unknown path" });
}

// Surface the host-owned message log live for an owner's room. The chat read is
// gated on the room being in the owner's registry, reads the existing host log,
// and never persists message content centrally.
async function sendRoomMessages(
  options: PlatformHttpServerOptions,
  roomId: string,
  url: URL,
  res: ServerResponse
): Promise<void> {
  const room = await readRoomResponse(options.root, roomId, ownerQuery(options));
  if (room.status !== 200) {
    sendJson(res, room.status, room.body);
    return;
  }
  const sinceId = parseSinceId(url.searchParams.get("since_id"));
  if (sinceId === null) {
    sendJson(res, 400, { ok: false, error: "invalid_since_id", message: "since_id must be a non-negative integer" });
    return;
  }
  let messages;
  try {
    messages = (await readMessages(options.root, roomId)).filter((message) => message.id > sinceId);
  } catch {
    // The room is registered but its host log is not present locally (e.g. a
    // remote host): report an empty, offline timeline rather than failing.
    sendJson(res, 200, { ok: true, messages: [], next_since_id: sinceId, host_log_available: false });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    messages,
    next_since_id: messages.at(-1)?.id ?? sinceId,
    host_log_available: true
  });
}

// Surface the device-local joined-room list for the owner shell's "Rooms I'm in"
// section. Metadata only (the JoinedRoom record holds no token), plus a live,
// token-free reachability probe so the shell can show honest live/unreachable/
// expired states without ever needing the participant's credential.
async function sendJoinedRooms(options: PlatformHttpServerOptions, res: ServerResponse): Promise<void> {
  const rooms = await readJoinedRooms(options.root);
  const withReachability = await Promise.all(
    rooms.map(async (room) => ({ ...room, reachability: await probeReachability(room.baseUrl) }))
  );
  sendJson(res, 200, { ok: true, rooms: withReachability });
}

// Record a browser join into the device-local store (the same-device bridge). The
// record is rebuilt from a strict metadata allowlist and the base URL is reduced to
// origin+path, so a token in any field or in the URL (?token=/#token=) can never be
// persisted. Bad input is a 400; it never throws the request open.
async function recordJoinedRoomFromRequest(
  options: PlatformHttpServerOptions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Minimal CSRF hardening for the same-device bridge: the caller is a browser room
  // page on the same box, so its Origin must be loopback. Cross-site/off-box origins
  // (the CSRF/exfil vector) are refused; the bridge stays local-only.
  if (!isLoopbackOrigin(req.headers.origin)) {
    sendJson(res, 403, { ok: false, error: "bad_origin", message: "joined-room bridge is loopback-only" });
    return;
  }
  let body: { roomId?: unknown; title?: unknown; alias?: unknown; baseUrl?: unknown };
  try {
    body = JSON.parse(await readRequestBody(req)) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid_json", message: "body must be JSON" });
    return;
  }
  const baseUrl = sanitizeBaseUrl(body.baseUrl);
  if (baseUrl === null) {
    sendJson(res, 400, { ok: false, error: "invalid_base_url", message: "baseUrl must be an http(s) URL" });
    return;
  }
  const now = new Date().toISOString();
  await recordJoinedRoom(options.root, {
    roomId: shortString(body.roomId) ?? baseUrl,
    title: shortString(body.title) ?? shortString(body.roomId) ?? baseUrl,
    alias: shortString(body.alias) ?? "",
    baseUrl,
    joinedAt: now,
    lastSeen: now
  });
  sendJson(res, 200, { ok: true });
}

// Reduce a candidate URL to origin + path, dropping any query/hash so a token in
// ?token= / #token= can never survive into the stored record.
function sanitizeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "") || url.origin;
}

// The bridge accepts writes only from a same-device (loopback) browser origin. An
// absent Origin (non-browser caller) is rejected too — a browser fetch always sends
// one. Legitimate local rooms are served from loopback, so this never blocks them.
function isLoopbackOrigin(origin: string | undefined): boolean {
  if (typeof origin !== "string" || origin.length === 0) return false;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function shortString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, 200);
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 8_192) throw new Error("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Token-free reachability: GET the room's base URL (the unauthenticated browser
// shell / broker route). A 2xx means live; a 410 or a broker route_expired/closed
// body means the route is gone; anything else — including a network failure or the
// 1.5s timeout — is treated as unreachable.
async function probeReachability(baseUrl: string): Promise<"live" | "unreachable" | "expired"> {
  const target = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(target, { method: "GET", signal: controller.signal });
    if (response.ok) return "live";
    if (response.status === 410) return "expired";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error === "route_expired" || body.error === "route_closed" || body.error === "route_not_found") {
        return "expired";
      }
    } catch {
      // Non-JSON error body — fall through to unreachable.
    }
    return "unreachable";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

async function sendAsset(res: ServerResponse, file: string, contentType: string): Promise<void> {
  const body = await readFile(new URL(`../browser/${file}`, import.meta.url));
  res.writeHead(200, { "content-type": contentType, "content-length": body.byteLength });
  res.end(body);
}

function parseSinceId(raw: string | null): number | null {
  if (raw === null) return 0;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function isLocalhost(hostHeader: string | undefined): boolean {
  const host = (hostHeader ?? "").split(":")[0] ?? "";
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function ownerQuery(options: PlatformHttpServerOptions): PlatformOwnerQuery {
  if (options.devOwner !== undefined) return { dev_owner: options.devOwner };
  if (options.ownerUserId !== undefined) return { owner_user_id: options.ownerUserId };
  return { dev_owner: devOwnerIdentityFromEnv() };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}
