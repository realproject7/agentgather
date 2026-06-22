// Broker forwarding core.
//
// Forwards a participant request from the broker to the host room server and
// streams the response back. The host room server stays the only authority for
// participant tokens and sender identity: this module never injects a `from`
// field and never inspects or stores request/response bodies. Long-poll `/wait`
// responses are streamed, not buffered to completion. Request and forwarded
// response sizes are capped per the broker resource limits.

import { once } from "node:events";
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

export interface ForwardOptions {
  target: string;
  // Path plus query string to forward, beginning with "/".
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  requestBodyBytes: number;
  responseBodyBytes: number;
}

export interface ForwardResult {
  status: number;
  bytesIn: number;
  bytesOut: number;
}

/**
 * Forward a single participant request to the host room server. Throws a
 * TunnelError (before any response is written) when the host is unreachable or
 * the request body is too large; once the response stream begins, transport
 * failures or an over-limit response just close the socket.
 */
export async function forwardToHost(options: ForwardOptions): Promise<ForwardResult> {
  const targetBase = normalizeBaseUrl(options.target);
  const targetUrl = `${targetBase}${options.path.startsWith("/") ? options.path : `/${options.path}`}`;
  const method = options.req.method ?? "GET";

  const headers = selectRequestHeaders(options.req, new URL(targetBase).origin);
  const body = await readRequestBody(options.req, method, options.requestBodyBytes);
  const bytesIn = body?.length ?? 0;

  const init: RequestInit = { method, headers, redirect: "manual" };
  if (body !== undefined) init.body = new Uint8Array(body);

  let response: Response;
  try {
    response = await fetch(targetUrl, init);
  } catch {
    throw new TunnelError("internal_error", 502, "could not reach the host room server");
  }

  // When the host declares an over-limit content-length we can still reject
  // cleanly with a stable error before committing any upstream headers.
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > options.responseBodyBytes) {
    throw new TunnelError("response_too_large", 502, "forwarded response exceeds the broker limit");
  }

  const responseHeaders: Record<string, string> = {};
  const contentType = response.headers.get("content-type");
  if (contentType !== null) responseHeaders["content-type"] = contentType;
  options.res.writeHead(response.status, responseHeaders);

  const bytesOut = await streamResponse(response, options.res, options.responseBodyBytes);
  return { status: response.status, bytesIn, bytesOut };
}

async function streamResponse(
  response: Response,
  res: ServerResponse,
  responseBodyBytes: number
): Promise<number> {
  if (response.body === null) {
    res.end();
    return 0;
  }
  // Stream the body through without buffering it to completion, so held /wait
  // responses are released as soon as the host responds. If a body with no (or
  // an understated) content-length grows past the cap, headers are already
  // committed, so we destroy the socket and throw response_too_large — the
  // caller logs it as a limit failure rather than a successful forward.
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  let bytesOut = 0;
  let overflow = false;
  try {
    for await (const chunk of source) {
      const buffer = chunk as Buffer;
      bytesOut += buffer.length;
      if (bytesOut > responseBodyBytes) {
        overflow = true;
        source.destroy();
        break;
      }
      if (!res.write(buffer)) await once(res, "drain");
    }
  } catch {
    res.destroy();
    return bytesOut;
  }
  if (overflow) {
    res.destroy();
    throw new TunnelError("response_too_large", 502, "forwarded response exceeds the broker limit");
  }
  res.end();
  return bytesOut;
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

async function readRequestBody(
  req: IncomingMessage,
  method: string,
  limitBytes: number
): Promise<Buffer | undefined> {
  if (method === "GET" || method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.length;
    if (total > limitBytes) {
      throw new TunnelError("request_too_large", 413, "request body exceeds the broker limit");
    }
    chunks.push(buffer);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}
