import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRoom, writeParticipants } from "../src/storage/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
import { ALLOW_REMOTE_WARNING } from "../src/cli/commands/room/index.js";
import type { Participant } from "../src/protocol/index.js";

// #180: a free user publishes with their own tunnel / reverse proxy in front of
// `room serve --url <public> --allow-remote`. A real proxy rewrites the Host
// header to the public authority and the browser sends the public Origin. This
// exercises that path end-to-end (join / messages / `/wait` long-poll) plus the
// origin guardrail, without any Agent Gather service.

const PUBLIC_HOST = "room.example.com";
const PUBLIC_ORIGIN = `http://${PUBLIC_HOST}`;

const mkP = (alias: string, kind: Participant["kind"], token: string, host = false): Participant => ({
  alias,
  kind,
  location: "local",
  install: host ? "host" : "lite",
  attention: "manual",
  is_host: host,
  token_hash: participantTokenHash(token),
  joinedAt: "2026-06-21T00:00:00.000Z",
  lastSeenAt: "2026-06-21T00:00:00.000Z"
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// A reverse proxy that forwards to the local room server, rewriting the Host
// header to the public authority (like nginx `proxy_set_header Host $host` /
// Cloudflare Tunnel). Request and response are STREAMED so `/wait` long-poll is
// not buffered.
function startReverseProxy(upstreamPort: number): Server {
  return createServer((clientReq, clientRes) => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        method: clientReq.method,
        path: clientReq.url,
        headers: { ...clientReq.headers, host: PUBLIC_HOST }
      },
      (upstreamRes: IncomingMessage) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      }
    );
    upstream.on("error", () => {
      if (!clientRes.headersSent) clientRes.writeHead(502);
      clientRes.end();
    });
    clientReq.pipe(upstream);
  });
}

interface ProxyResult {
  status: number;
  body: any;
}

// A client hitting the proxy edge. Origin defaults to the public origin (what a
// browser served from the public URL sends); the proxy rewrites Host upstream.
function proxyRequest(
  proxyPort: number,
  method: string,
  urlPath: string,
  options: { token?: string; origin?: string | null; body?: unknown } = {}
): Promise<ProxyResult> {
  return new Promise((resolve, reject) => {
    const data = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string | number> = {};
    if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
    const origin = options.origin === undefined ? PUBLIC_ORIGIN : options.origin;
    if (origin !== null) headers.Origin = origin;
    if (data !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = httpRequest({ host: "127.0.0.1", port: proxyPort, method, path: urlPath, headers }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

async function fixture(options: { allowInsecureRemote?: boolean } = {}): Promise<{
  root: string;
  roomId: string;
  proxyPort: number;
  hostToken: string;
  reviewerToken: string;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-rproxy-"));
  const roomId = "demo";
  const hostToken = "tgl_host_secret";
  const reviewerToken = "tgl_reviewer_secret";
  await createRoom({ root, roomId, hostAlias: "host", briefBody: "Publish via your own tunnel." });
  await writeParticipants(root, roomId, [mkP("host", "human", hostToken, true), mkP("reviewer", "agent", reviewerToken)]);

  const room = createRoomHttpServer({
    root,
    roomId,
    baseUrl: PUBLIC_ORIGIN,
    allowInsecureRemote: options.allowInsecureRemote ?? true,
    waitHoldMs: 4_000,
    rateLimitPerMinute: 1_000
  });
  const roomPort = await listen(room);
  const proxy = startReverseProxy(roomPort);
  const proxyPort = await listen(proxy);

  return {
    root,
    roomId,
    proxyPort,
    hostToken,
    reviewerToken,
    close: async () => {
      await closeServer(proxy);
      await closeServer(room);
    }
  };
}

test("behind a reverse proxy (rewritten Host/public Origin), join + messages + /wait long-poll work with --allow-remote (#180)", async () => {
  const fx = await fixture();
  try {
    // Join through the proxy — write path passes the same-origin guard against
    // the public origin, and the rewritten non-localhost Host passes because
    // --allow-remote (allowInsecureRemote) is set.
    const joined = await proxyRequest(fx.proxyPort, "POST", "/join", { token: fx.reviewerToken });
    assert.equal(joined.status, 200);

    const sent = await proxyRequest(fx.proxyPort, "POST", "/messages", {
      token: fx.reviewerToken,
      body: { text: "@host through the tunnel" }
    });
    assert.equal(sent.status, 201);

    const read = await proxyRequest(fx.proxyPort, "GET", "/messages?since_id=0", { token: fx.reviewerToken });
    assert.equal(read.status, 200);
    assert.equal(
      read.body.messages.some((m: { text: string }) => m.text === "@host through the tunnel"),
      true
    );
    const sinceId = read.body.next_since_id as number;

    // /wait long-poll through the proxy: the held request is released by a later
    // send and delivers the new message (streamed, not buffered by the proxy).
    const waiting = proxyRequest(fx.proxyPort, "GET", `/wait?participant=reviewer&since_id=${sinceId}`, {
      token: fx.reviewerToken
    });
    const releaser = new Promise<void>((resolve) => setTimeout(resolve, 60)).then(() =>
      proxyRequest(fx.proxyPort, "POST", "/messages", { token: fx.hostToken, body: { text: "@reviewer released" } })
    );
    const [waitResult] = await Promise.all([waiting, releaser]);
    assert.equal(waitResult.status, 200);
    assert.equal(
      waitResult.body.messages.some((m: { text: string }) => m.text === "@reviewer released"),
      true
    );
    assert.equal(waitResult.body.keep_waiting, false);
  } finally {
    await fx.close();
  }
});

test("behind the proxy, a mismatched Origin is still rejected (bad_origin), and --allow-remote is required (#180)", async () => {
  const fx = await fixture();
  try {
    const badOrigin = await proxyRequest(fx.proxyPort, "POST", "/messages", {
      token: fx.reviewerToken,
      origin: "http://evil.example",
      body: { text: "cross origin" }
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.body.error, "bad_origin");
  } finally {
    await fx.close();
  }

  // Without --allow-remote, the rewritten non-localhost Host is rejected: the
  // guardrail that makes --allow-remote a deliberate opt-in.
  const guarded = await fixture({ allowInsecureRemote: false });
  try {
    const blocked = await proxyRequest(guarded.proxyPort, "GET", "/status", { token: guarded.hostToken });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, "insecure_remote");
  } finally {
    await guarded.close();
  }
});

test("--allow-remote warning states the HTTPS-at-edge assumption and transit trust (#180)", () => {
  assert.match(ALLOW_REMOTE_WARNING, /--allow-remote/);
  assert.match(ALLOW_REMOTE_WARNING, /HTTPS must be terminated at the edge/i);
  assert.match(ALLOW_REMOTE_WARNING, /never expose plain http:\/\//i);
  assert.match(ALLOW_REMOTE_WARNING, /tokens transit/i);
  assert.match(ALLOW_REMOTE_WARNING, /127\.0\.0\.1/);
  assert.match(ALLOW_REMOTE_WARNING, /docs\/self-tunnel\.md/);
});

test("the self-tunnel recipe documents ngrok + Cloudflare, the trust statement, and carries no real bearer token (#180)", async () => {
  const doc = await readFile(path.join(process.cwd(), "docs", "self-tunnel.md"), "utf8");
  assert.match(doc, /ngrok/);
  assert.match(doc, /cloudflared|Cloudflare Tunnel/);
  assert.match(doc, /--allow-remote/);
  // Trust statement: exactly what the provider can and cannot see, citing the scope doc.
  assert.match(doc, /can and cannot see/i);
  assert.match(doc, /CANNOT see/);
  assert.match(doc, /v2-mvp-scope\.md/);
  assert.match(doc, /same trust class/i);
  // Examples use safe fill-ins — no realistic bearer token literal in the recipe.
  assert.doesNotMatch(doc, /tgl_[A-Za-z0-9_-]{8,}/);
});
