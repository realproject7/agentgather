// Control plane HTTP surface for the owner browser shell.
//
// Serves the owner shell static assets and the read-only platform API the shell
// consumes: room list/status from the #80/#81 control-plane handlers, and a
// chat read that surfaces the host-owned message log live (never stored
// centrally). It is bound to localhost and scoped to a single configured owner;
// real account authentication and multi-owner scoping are #87, not this ticket.
//
// The shell's two data sources stay separate here: registry/status comes from
// the platform handlers, while the chat pane reads the existing host-owned room
// message log via the same storage the room server uses.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { readMessages } from "../storage/index.js";
import { listRoomsResponse, readRoomResponse } from "./api.js";

export interface PlatformHttpServerOptions {
  /** Home directory holding the control-plane registry and host room logs. */
  root: string;
  /** Owner the shell is scoped to. A stand-in for the #87 account session. */
  ownerUserId: string;
  /** Allow non-localhost Host headers. Off by default to avoid open exposure. */
  allowInsecureRemote?: boolean;
}

const ASSETS: Record<string, { file: string; contentType: string }> = {
  "/": { file: "shell.html", contentType: "text/html; charset=utf-8" },
  "/shell.css": { file: "shell.css", contentType: "text/css; charset=utf-8" },
  "/shell.js": { file: "shell.js", contentType: "text/javascript; charset=utf-8" }
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
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "read-only surface" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://platform.local");
  const asset = ASSETS[url.pathname];
  if (asset !== undefined) {
    await sendAsset(res, asset.file, asset.contentType);
    return;
  }

  const query = { owner_user_id: options.ownerUserId };
  if (url.pathname === "/rooms") {
    const result = await listRoomsResponse(options.root, query);
    sendJson(res, result.status, result.body);
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
  const room = await readRoomResponse(options.root, roomId, { owner_user_id: options.ownerUserId });
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

async function sendAsset(res: ServerResponse, file: string, contentType: string): Promise<void> {
  const body = await readFile(new URL(`../browser/${file}`, import.meta.url), "utf8");
  res.writeHead(200, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}
