// Broker forwarding core.
//
// Forwards a participant request from the broker to the host room server and
// streams the response back. The host room server stays the only authority for
// participant tokens and sender identity: this module never injects a `from`
// field and never inspects or stores request/response bodies. Long-poll `/wait`
// responses are streamed, not buffered to completion.

import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { normalizeBaseUrl } from "../protocol/index.js";
import { TunnelError } from "./protocol.js";

// Request headers passed through to the host. The Authorization header carries
// the participant token the host uses to derive sender identity. Origin and
// Referer are translated to the host origin so the host's same-origin checks
// stay correct for remote POSTs. Hop-by-hop and host-identifying headers are
// dropped.
const FORWARDED_REQUEST_HEADERS = new Set(["authorization", "content-type", "accept"]);
const MAX_FORWARDED_BODY_BYTES = 1_000_000;

export interface ForwardOptions {
  target: string;
  // Path plus query string to forward, beginning with "/".
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
}

/**
 * Forward a single participant request to the host room server. Throws a
 * TunnelError (before any response is written) when the host is unreachable;
 * once the response stream begins, transport failures just close the socket.
 */
export async function forwardToHost(options: ForwardOptions): Promise<void> {
  const targetBase = normalizeBaseUrl(options.target);
  const targetUrl = `${targetBase}${options.path.startsWith("/") ? options.path : `/${options.path}`}`;
  const method = options.req.method ?? "GET";

  const headers = selectRequestHeaders(options.req, new URL(targetBase).origin);
  const body = await readRequestBody(options.req, method);

  const init: RequestInit = { method, headers, redirect: "manual" };
  if (body !== undefined) init.body = new Uint8Array(body);

  let response: Response;
  try {
    response = await fetch(targetUrl, init);
  } catch {
    throw new TunnelError("internal_error", 502, "could not reach the host room server");
  }

  const responseHeaders: Record<string, string> = {};
  const contentType = response.headers.get("content-type");
  if (contentType !== null) responseHeaders["content-type"] = contentType;
  options.res.writeHead(response.status, responseHeaders);

  if (response.body === null) {
    options.res.end();
    return;
  }
  // Stream the body through without buffering it to completion, so held /wait
  // responses are released as soon as the host responds.
  const bodyStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  try {
    await pipeline(bodyStream, options.res);
  } catch {
    options.res.destroy();
  }
}

function selectRequestHeaders(req: IncomingMessage, targetOrigin: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (FORWARDED_REQUEST_HEADERS.has(lower)) {
      headers[lower] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  // Translate browser-supplied origin/referer to the host origin so same-origin
  // protections pass through the tunnel without trusting a client-supplied from.
  if (req.headers.origin !== undefined) headers.origin = targetOrigin;
  if (req.headers.referer !== undefined) headers.referer = `${targetOrigin}/`;
  return headers;
}

async function readRequestBody(req: IncomingMessage, method: string): Promise<Buffer | undefined> {
  if (method === "GET" || method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.length;
    if (total > MAX_FORWARDED_BODY_BYTES) {
      throw new TunnelError("internal_error", 413, "forwarded request body is too large");
    }
    chunks.push(buffer);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

function pipeline(source: Readable, destination: ServerResponse): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    source.on("error", reject);
    destination.on("error", reject);
    destination.on("finish", resolve);
    source.pipe(destination);
  });
}
