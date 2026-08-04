import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VERSION } from "../src/cli/help.js";
import { createPlatformHttpServer } from "../src/platform/index.js";
import { createControlPlaneRoom } from "../src/platform/index.js";
import { appendServerMessage, createBoardroom, createRoom, recordJoinedRoom, roomPaths } from "../src/storage/index.js";
import { createRoomHttpServer } from "../src/server/index.js";

function requestWithHost(baseUrl: string, hostHeader: string): Promise<{ status: number; body: string }> {
  const url = new URL("/rooms", baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: { host: hostHeader } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-platform-http-test-"));
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function roomInput(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    title: "A Room",
    owner_user_id: "owner-1",
    route_url: "https://rooms.agentgather.dev/room",
    status: "active",
    roster: [{ alias: "host", kind: "human", role: "host", status: "attending" }],
    route_health: { reachable: true, host_connected: true },
    last_synced_message_id: 0,
    ...overrides
  };
}

async function startServer(
  root: string,
  ownerUserId: string
): Promise<{ baseUrl: string; close: () => Promise<void>; server: Server }> {
  const server = createPlatformHttpServer({ root, ownerUserId });
  const port = await getFreePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

test("serves the owner shell assets", async () => {
  const root = await makeRoot();
  const fixture = await startServer(root, "owner-1");
  try {
    const html = await fetch(`${fixture.baseUrl}/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /shell.css/);
    const js = await fetch(`${fixture.baseUrl}/shell.js`);
    assert.equal(js.status, 200);
    assert.match(await js.text(), /platform-shell|loadRooms/);
    const theme = await fetch(`${fixture.baseUrl}/theme.css`);
    assert.equal(theme.status, 200);
    assert.match(await theme.text(), /--accent: #ec5c94/);
    const logo = await fetch(`${fixture.baseUrl}/agentgather-logo.png`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get("content-type"), "image/png");
    assert.ok((await logo.arrayBuffer()).byteLength > 1000);
    const manifest = await fetch(`${fixture.baseUrl}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.equal((await manifest.json()).short_name, "Agent Gather");
    const version = await fetch(`${fixture.baseUrl}/version`);
    assert.equal(version.status, 200);
    assert.equal((await version.json()).version, VERSION);
  } finally {
    await fixture.close();
  }
});

test("lists only the owner's rooms and reads one room's metadata", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "alpha", status: "active" }));
  await createControlPlaneRoom(root, roomInput({ room_id: "beta", status: "paused", status_reason: "host_unavailable" }));
  await createControlPlaneRoom(root, roomInput({ room_id: "gamma", owner_user_id: "owner-2" }));

  const fixture = await startServer(root, "owner-1");
  try {
    const list = await (await fetch(`${fixture.baseUrl}/rooms`)).json();
    assert.deepEqual(
      (list.rooms as Array<{ room_id: string }>).map((room) => room.room_id),
      ["alpha", "beta"]
    );

    const beta = await (await fetch(`${fixture.baseUrl}/rooms/beta`)).json();
    assert.equal(beta.room.status, "paused");
    assert.equal(beta.room.status_reason, "host_unavailable");

    const other = await fetch(`${fixture.baseUrl}/rooms/gamma`);
    assert.equal(other.status, 404);
  } finally {
    await fixture.close();
  }
});

test("hosted room responses expose sanitized channels over the HTTP surface", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "alpha" }));
  await createControlPlaneRoom(root, roomInput({ room_id: "legacy" }));
  await createRoom({ root, roomId: "alpha", hostAlias: "host" });
  await createBoardroom(root, "alpha", {
    channels: [
      { id: "general", name: "general", type: "chat", lifecycle: "active", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "ideas", name: "Ideas", type: "forum", lifecycle: "active", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "old", name: "Old", type: "forum", lifecycle: "removed", createdAt: "2026-01-01T00:00:00.000Z" }
    ]
  });

  const fixture = await startServer(root, "owner-1");
  try {
    const alpha = await (await fetch(`${fixture.baseUrl}/rooms/alpha`)).json();
    assert.deepEqual(alpha.room.channels, [
      { id: "general", name: "general", type: "chat" },
      { id: "ideas", name: "Ideas", type: "forum" }
    ]);

    // A room with no boardroom store falls back to a single #general chat channel.
    const legacy = await (await fetch(`${fixture.baseUrl}/rooms/legacy`)).json();
    assert.deepEqual(legacy.room.channels, [{ id: "general", name: "general", type: "chat" }]);

    // The list surface carries the same sanitized channels, and the removed
    // channel and its internal fields never cross the wire.
    const listRaw = await (await fetch(`${fixture.baseUrl}/rooms`)).text();
    assert.doesNotMatch(listRaw, /"old"|"removed"|"lifecycle"|"createdAt"/);
    const list = JSON.parse(listRaw) as { rooms: Array<{ room_id: string; channels: unknown[] }> };
    assert.deepEqual(list.rooms.find((room) => room.room_id === "alpha")?.channels, [
      { id: "general", name: "general", type: "chat" },
      { id: "ideas", name: "Ideas", type: "forum" }
    ]);
  } finally {
    await fixture.close();
  }
});

test("chat read surfaces the live host-owned message log for an owner's room", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "demo-room" }));
  await createRoom({ root, roomId: "demo-room", hostAlias: "host", briefBody: "go" });
  await appendServerMessage({ root, roomId: "demo-room", from: "system", text: "demo-room opened" });

  const fixture = await startServer(root, "owner-1");
  try {
    const payload = await (await fetch(`${fixture.baseUrl}/rooms/demo-room/messages?since_id=0`)).json();
    assert.equal(payload.host_log_available, true);
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].text, "demo-room opened");
    assert.equal(typeof payload.next_since_id, "number");
  } finally {
    await fixture.close();
  }
});

test("chat read reports the host log offline when the registered room has no local log", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "remote-room" }));

  const fixture = await startServer(root, "owner-1");
  try {
    const payload = await (await fetch(`${fixture.baseUrl}/rooms/remote-room/messages?since_id=0`)).json();
    assert.equal(payload.host_log_available, false);
    assert.deepEqual(payload.messages, []);
  } finally {
    await fixture.close();
  }
});

// #242: an absent host log and a broken local store used to be indistinguishable
// — every readMessages failure returned HTTP 200 with an empty timeline and
// host_log_available:false, so a real storage fault was presented as "the host is
// simply offline". Only a genuinely missing log keeps that offline shape now.

test("chat read keeps the offline shape when the host log file itself is absent (#242)", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "no-log-room" }));
  await createRoom({ root, roomId: "no-log-room", hostAlias: "host", briefBody: "go" });
  // The room exists locally but its message log does not — the expected ENOENT
  // condition, distinct from the whole room being absent.
  await rm(roomPaths(root, "no-log-room").messages, { force: true });

  const fixture = await startServer(root, "owner-1");
  try {
    const response = await fetch(`${fixture.baseUrl}/rooms/no-log-room/messages?since_id=0`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.host_log_available, false);
    assert.deepEqual(payload.messages, []);
    assert.equal(payload.next_since_id, 0);
  } finally {
    await fixture.close();
  }
});

test("chat read surfaces a corrupt host log as a server error, never as an empty timeline (#242)", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "corrupt-room" }));
  await createRoom({ root, roomId: "corrupt-room", hostAlias: "host", briefBody: "go" });
  await appendServerMessage({ root, roomId: "corrupt-room", from: "system", text: "sensitive-log-body" });
  // A truncated/garbled line: JSON.parse throws a SyntaxError, which carries no
  // errno and so must not be mistaken for an absent log.
  await appendFile(roomPaths(root, "corrupt-room").messages, "{ not valid json\n", "utf8");

  const fixture = await startServer(root, "owner-1");
  try {
    const response = await fetch(`${fixture.baseUrl}/rooms/corrupt-room/messages?since_id=0`);
    const body = await response.text();
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(body), { ok: false, error: "internal_error" });
    // The whole point: a corrupt store must not claim the host is merely offline.
    assert.doesNotMatch(body, /host_log_available/);
    // and the failure must not disclose the log's contents or where it lives
    assert.doesNotMatch(body, /sensitive-log-body/);
    assert.doesNotMatch(body, /messages\.jsonl/);
    assert.equal(body.includes(root), false);
  } finally {
    await fixture.close();
  }
});

test("chat read surfaces an unreadable host log as a server error (#242)", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "unreadable-room" }));
  await createRoom({ root, roomId: "unreadable-room", hostAlias: "host", briefBody: "go" });
  // Replace the log with a directory: reading it fails with EISDIR on every
  // platform and for every user. A chmod-based case would be silently skipped
  // wherever the suite runs as root.
  const messagesPath = roomPaths(root, "unreadable-room").messages;
  await rm(messagesPath, { force: true });
  await mkdir(messagesPath);

  const fixture = await startServer(root, "owner-1");
  try {
    const response = await fetch(`${fixture.baseUrl}/rooms/unreadable-room/messages?since_id=0`);
    const body = await response.text();
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(body), { ok: false, error: "internal_error" });
    assert.doesNotMatch(body, /host_log_available/);
    assert.equal(body.includes(root), false);
  } finally {
    await fixture.close();
  }
});

test("chat read for another owner's room is not found", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "owned", owner_user_id: "owner-2" }));
  await createRoom({ root, roomId: "owned", hostAlias: "host" });
  await appendServerMessage({ root, roomId: "owned", from: "system", text: "secret" });

  const fixture = await startServer(root, "owner-1");
  try {
    const response = await fetch(`${fixture.baseUrl}/rooms/owned/messages?since_id=0`);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /secret/);
  } finally {
    await fixture.close();
  }
});

test("a non-localhost Host header is rejected", async () => {
  const root = await makeRoot();
  const fixture = await startServer(root, "owner-1");
  try {
    const response = await requestWithHost(fixture.baseUrl, "platform.example.com");
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.body).error, "insecure_remote");
  } finally {
    await fixture.close();
  }
});

test("/joined-rooms returns device-local joined rooms with honest reachability and no tokens (#178)", async () => {
  const root = await makeRoot();

  // A live room server to probe (its GET / serves the browser shell, unauthenticated).
  await createRoom({ root, roomId: "live-room", hostAlias: "host", briefBody: "go" });
  const roomServer = createRoomHttpServer({ root, roomId: "live-room", baseUrl: "http://127.0.0.1:0", rateLimitPerMinute: 1000 });
  const livePort = await getFreePort();
  await new Promise<void>((resolve) => roomServer.listen(livePort, "127.0.0.1", resolve));
  const liveUrl = `http://127.0.0.1:${livePort}`;
  const deadUrl = `http://127.0.0.1:${await getFreePort()}`; // nothing is listening here

  const now = new Date().toISOString();
  await recordJoinedRoom(root, { roomId: "live-room", title: "Live Room", alias: "me", baseUrl: liveUrl, joinedAt: now, lastSeen: now });
  await recordJoinedRoom(root, { roomId: "gone-room", title: "Gone Room", alias: "me", baseUrl: deadUrl, joinedAt: now, lastSeen: now });

  const fixture = await startServer(root, "owner-1");
  try {
    const res = await fetch(`${fixture.baseUrl}/joined-rooms`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; rooms: Array<{ roomId: string; reachability: string }> };
    assert.equal(body.ok, true);
    const byId = Object.fromEntries(body.rooms.map((room) => [room.roomId, room]));
    assert.equal(byId["live-room"]?.reachability, "live");
    assert.equal(byId["gone-room"]?.reachability, "unreachable");
    // Metadata only — no token anywhere in the response.
    assert.equal(/tgl_|Bearer|"token"/i.test(JSON.stringify(body)), false);
  } finally {
    await fixture.close();
    await new Promise<void>((resolve) => roomServer.close(() => resolve()));
  }
});

function postJoinedRoom(baseUrl: string, origin: string, body: string): Promise<{ status: number; body: string }> {
  const url = new URL("/joined-rooms", baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { origin, "content-type": "text/plain" }
      },
      (res) => {
        let payload = "";
        res.on("data", (chunk) => {
          payload += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: payload }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

test("the joined-rooms bridge rejects a non-loopback Origin and persists nothing (#178)", async () => {
  const root = await makeRoot();
  const fixture = await startServer(root, "owner-1");
  try {
    const res = await postJoinedRoom(
      fixture.baseUrl,
      "http://evil.com",
      JSON.stringify({ roomId: "x", baseUrl: "http://127.0.0.1:8787" })
    );
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).error, "bad_origin");
    // The forged cross-origin write left no record.
    const list = (await (await fetch(`${fixture.baseUrl}/joined-rooms`)).json()) as { rooms: unknown[] };
    assert.equal(list.rooms.length, 0);
  } finally {
    await fixture.close();
  }
});

test("the joined-rooms bridge persists only sanitized metadata from a loopback Origin (#178)", async () => {
  const root = await makeRoot();
  // #257: reading /joined-rooms runs `probeReachability` against every stored
  // baseUrl. Pointed at the product default port that was a real GET to whatever
  // process owns 127.0.0.1:8787 — a request to a listener this suite never
  // started. Bind one the test owns and hold it for the duration; the `#token=`
  // fragment is kept exactly as it was, because it is the redaction fixture.
  const probed = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => {
    probed.listen(0, "127.0.0.1", resolve);
  });
  const probedOrigin = `http://127.0.0.1:${(probed.address() as AddressInfo).port}`;
  const fixture = await startServer(root, "owner-1");
  try {
    // A hostile body: a token field + a #token= in the URL. Neither may survive.
    const body = JSON.stringify({
      roomId: "demo",
      title: "Demo",
      alias: "me",
      baseUrl: `${probedOrigin}/#token=tgl_secret_leak`,
      token: "tgl_should_be_dropped"
    });
    const res = await postJoinedRoom(fixture.baseUrl, "http://127.0.0.1:5555", body);
    assert.equal(res.status, 200);
    const list = (await (await fetch(`${fixture.baseUrl}/joined-rooms`)).json()) as {
      rooms: Array<{ baseUrl: string }>;
    };
    assert.equal(list.rooms.length, 1);
    // baseUrl reduced to origin (fragment dropped); no token field anywhere.
    assert.equal(list.rooms[0]?.baseUrl, probedOrigin);
    assert.equal(/tgl_|"token"|Bearer/i.test(JSON.stringify(list.rooms)), false);
  } finally {
    await fixture.close();
    probed.closeAllConnections();
    await new Promise<void>((resolve) => probed.close(() => resolve()));
  }
});

// ---- #247 offline-history bridge ----
// The receiver takes its target from the capability, never from the body, and
// treats the body as hostile: size-capped, allowlisted, and re-redacted.

function postJoinedHistory(baseUrl: string, origin: string, body: string): Promise<{ status: number; body: string }> {
  const url = new URL("/joined-rooms/history", baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { origin, "content-type": "text/plain" }
      },
      (res) => {
        let payload = "";
        res.on("data", (chunk) => {
          payload += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: payload }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Take a real capability the only way one exists: from the open redirect.
async function mintCapability(baseUrl: string, roomId: string, roomBaseUrl: string): Promise<string> {
  const url = new URL("/joined-rooms/open", baseUrl);
  url.searchParams.set("room_id", roomId);
  url.searchParams.set("base_url", roomBaseUrl);
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 302);
  const location = res.headers.get("location") ?? "";
  const fragment = new URLSearchParams(location.slice(location.indexOf("#") + 1));
  const capability = fragment.get("snapshot");
  assert.equal(typeof capability, "string");
  return capability as string;
}

async function seedJoinedRoom(root: string, roomId: string, roomBaseUrl: string): Promise<void> {
  const { writeToken } = await import("../src/cli/state.js");
  const now = new Date().toISOString();
  await recordJoinedRoom(root, { roomId, title: "Snapshot Room", alias: "project7", baseUrl: roomBaseUrl, joinedAt: now, lastSeen: now });
  await writeToken(root, roomId, "project7", "tgl_snapshot_open_token");
}

test("the history bridge refuses a non-loopback origin and an unknown capability (#247)", async () => {
  const root = await makeRoot();
  const roomBaseUrl = "http://127.0.0.1:9";
  await seedJoinedRoom(root, "snap-room", roomBaseUrl);
  const fixture = await startServer(root, "owner-1");
  try {
    const capability = await mintCapability(fixture.baseUrl, "snap-room", roomBaseUrl);

    const crossOrigin = await postJoinedHistory(
      fixture.baseUrl,
      "http://evil.com",
      JSON.stringify({ capability, messages: [{ id: 1, text: "x" }] })
    );
    assert.equal(crossOrigin.status, 403);
    assert.equal(JSON.parse(crossOrigin.body).error, "bad_origin");

    const forged = await postJoinedHistory(
      fixture.baseUrl,
      "http://127.0.0.1:5999",
      JSON.stringify({ capability: "made-up-capability", messages: [{ id: 1, text: "x" }] })
    );
    assert.equal(forged.status, 403);
    assert.equal(JSON.parse(forged.body).error, "bad_capability");

    // Neither attempt produced a snapshot.
    const read = await fetch(
      `${fixture.baseUrl}/joined-rooms/history?room_id=snap-room&base_url=${encodeURIComponent(roomBaseUrl)}`
    );
    assert.equal(((await read.json()) as { snapshot: unknown }).snapshot, null);
  } finally {
    await fixture.close();
  }
});

test("the history bridge writes only where its capability points, ignoring body-supplied targets (#247)", async () => {
  const root = await makeRoot();
  const roomBaseUrl = "http://127.0.0.1:9";
  await seedJoinedRoom(root, "snap-room", roomBaseUrl);
  await seedJoinedRoom(root, "other-room", "http://127.0.0.1:8");
  const fixture = await startServer(root, "owner-1");
  try {
    const capability = await mintCapability(fixture.baseUrl, "snap-room", roomBaseUrl);
    // The body tries to name a different room and a filesystem path; both ignored.
    const res = await postJoinedHistory(
      fixture.baseUrl,
      "http://127.0.0.1:5999",
      JSON.stringify({
        capability,
        roomId: "../../../../etc/passwd",
        baseUrl: "http://127.0.0.1:8",
        messages: [{ id: 1, from: "project7", ts: "", type: "chat", text: "landed" }]
      })
    );
    assert.equal(res.status, 200);

    const target = (await (
      await fetch(`${fixture.baseUrl}/joined-rooms/history?room_id=snap-room&base_url=${encodeURIComponent(roomBaseUrl)}`)
    ).json()) as { snapshot: { messages: Array<{ text: string }> } | null };
    assert.equal(target.snapshot?.messages[0]?.text, "landed");

    const other = (await (
      await fetch(`${fixture.baseUrl}/joined-rooms/history?room_id=other-room&base_url=${encodeURIComponent("http://127.0.0.1:8")}`)
    ).json()) as { snapshot: unknown };
    assert.equal(other.snapshot, null, "the body could not redirect the write");
  } finally {
    await fixture.close();
  }
});

test("the history bridge re-redacts and bounds a hostile payload, and rejects an oversized body (#247)", async () => {
  const root = await makeRoot();
  const roomBaseUrl = "http://127.0.0.1:9";
  await seedJoinedRoom(root, "snap-room", roomBaseUrl);
  const fixture = await startServer(root, "owner-1");
  try {
    const capability = await mintCapability(fixture.baseUrl, "snap-room", roomBaseUrl);
    // A sender that skipped its own redaction must not be able to store a secret.
    const res = await postJoinedHistory(
      fixture.baseUrl,
      "http://127.0.0.1:5999",
      JSON.stringify({
        capability,
        messages: [
          { id: 1, from: "project7", ts: "", type: "chat", text: "raw tgl_unredacted_participant token" },
          { id: 2, from: "project7", ts: "", type: "chat", text: "Bearer abc.def" },
          { notAMessage: true },
          { id: "not-a-number", text: "dropped" }
        ]
      })
    );
    assert.equal(res.status, 200);

    const stored = (await (
      await fetch(`${fixture.baseUrl}/joined-rooms/history?room_id=snap-room&base_url=${encodeURIComponent(roomBaseUrl)}`)
    ).json()) as { snapshot: { messages: Array<{ id: number; text: string }> } | null };
    assert.equal(stored.snapshot?.messages.length, 2, "malformed entries were skipped, not coerced");
    assert.equal(/tgl_|Bearer /i.test(JSON.stringify(stored.snapshot)), false);

    // Anything past the body cap is refused outright rather than truncated silently.
    const oversized = await postJoinedHistory(
      fixture.baseUrl,
      "http://127.0.0.1:5999",
      JSON.stringify({ capability, messages: [{ id: 3, text: "y".repeat(400_000) }] })
    );
    assert.equal(oversized.status, 400);
    assert.equal(JSON.parse(oversized.body).error, "invalid_body");
  } finally {
    await fixture.close();
  }
});

test("history is served only for a tracked room and never leaks into joined-room metadata (#247)", async () => {
  const root = await makeRoot();
  const roomBaseUrl = "http://127.0.0.1:9";
  await seedJoinedRoom(root, "snap-room", roomBaseUrl);
  const fixture = await startServer(root, "owner-1");
  try {
    const capability = await mintCapability(fixture.baseUrl, "snap-room", roomBaseUrl);
    await postJoinedHistory(
      fixture.baseUrl,
      "http://127.0.0.1:5999",
      JSON.stringify({ capability, messages: [{ id: 1, from: "project7", ts: "", type: "chat", text: "private transcript line" }] })
    );

    // The token-free metadata surface carries no snapshot content.
    const metadata = await (await fetch(`${fixture.baseUrl}/joined-rooms`)).text();
    assert.equal(metadata.includes("private transcript line"), false);

    // An untracked room has no readable transcript.
    const untracked = await fetch(
      `${fixture.baseUrl}/joined-rooms/history?room_id=never-joined&base_url=${encodeURIComponent(roomBaseUrl)}`
    );
    assert.equal(untracked.status, 404);

    // Deleting the row removes the transcript with it.
    const { deleteJoinedRoom } = await import("../src/storage/index.js");
    await deleteJoinedRoom(root, { roomId: "snap-room", baseUrl: roomBaseUrl });
    const afterDelete = await fetch(
      `${fixture.baseUrl}/joined-rooms/history?room_id=snap-room&base_url=${encodeURIComponent(roomBaseUrl)}`
    );
    assert.equal(afterDelete.status, 404);
  } finally {
    await fixture.close();
  }
});

test("the history bridge redacts every persisted field, including from/author, and archived rows stay readable (#247)", async () => {
  const root = await makeRoot();
  const roomBaseUrl = "http://127.0.0.1:9";
  await seedJoinedRoom(root, "snap-room", roomBaseUrl);
  const fixture = await startServer(root, "owner-1");
  try {
    const capability = await mintCapability(fixture.baseUrl, "snap-room", roomBaseUrl);
    // A sender that puts credential-shaped values in metadata fields, not just in
    // bodies — the case that made a card URL renderable in the dashboard.
    const res = await postJoinedHistory(
      fixture.baseUrl,
      "http://127.0.0.1:5999",
      JSON.stringify({
        capability,
        messages: [
          {
            id: 1,
            from: "https://evil.example/card/abc123?token=tgl_leaked_secret_value",
            ts: "Bearer sk-live-abcdef",
            type: "tgl_type_secret_value",
            text: "ordinary body"
          }
        ],
        forumPosts: [
          {
            id: "p1",
            channel: "design",
            title: "ordinary title",
            author: "https://evil.example/card/abc123",
            ts: "Bearer sk-live-fedcba",
            status: "tgl_status_secret_value",
            body: "ordinary post body",
            comments: [{ id: "c1", author: "Bearer sk-live-comment", ts: "", body: "ordinary comment" }]
          }
        ]
      })
    );
    assert.equal(res.status, 200);

    // Exact expected values in the API response, not merely "the token is missing".
    const payload = (await (
      await fetch(`${fixture.baseUrl}/joined-rooms/history?room_id=snap-room&base_url=${encodeURIComponent(roomBaseUrl)}`)
    ).json()) as {
      snapshot: {
        messages: Array<{ from: string; ts: string; type: string; text: string }>;
        forumPosts: Array<{ author: string; ts: string; status: string; comments: Array<{ author: string }> }>;
      } | null;
    };
    assert.equal(payload.snapshot?.messages[0]?.from, "[redacted-url]");
    assert.equal(payload.snapshot?.messages[0]?.ts, "[redacted-credential]");
    assert.equal(payload.snapshot?.messages[0]?.type, "[redacted-token]");
    assert.equal(payload.snapshot?.messages[0]?.text, "ordinary body");
    assert.equal(payload.snapshot?.forumPosts[0]?.author, "[redacted-url]");
    assert.equal(payload.snapshot?.forumPosts[0]?.ts, "[redacted-credential]");
    assert.equal(payload.snapshot?.forumPosts[0]?.status, "[redacted-token]");
    assert.equal(payload.snapshot?.forumPosts[0]?.comments[0]?.author, "[redacted-credential]");
    assert.equal(/tgl_|Bearer |token=|evil\.example/i.test(JSON.stringify(payload)), false);

    // Archive keeps the transcript and the read path stays open, so un-archiving
    // restores a readable row — asserted rather than assumed.
    const { setJoinedRoomArchived } = await import("../src/storage/index.js");
    await setJoinedRoomArchived(root, { roomId: "snap-room", baseUrl: roomBaseUrl, archived: true });
    const archivedRead = await fetch(
      `${fixture.baseUrl}/joined-rooms/history?room_id=snap-room&base_url=${encodeURIComponent(roomBaseUrl)}`
    );
    assert.equal(archivedRead.status, 200);
    assert.equal(
      ((await archivedRead.json()) as { snapshot: { messages: unknown[] } | null }).snapshot?.messages.length,
      1,
      "archive keeps the saved transcript readable"
    );
    // ...but an archived row stops ingesting new history.
    const whileArchived = await postJoinedHistory(
      fixture.baseUrl,
      "http://127.0.0.1:5999",
      JSON.stringify({ capability, messages: [{ id: 2, from: "project7", ts: "", type: "chat", text: "after archive" }] })
    );
    assert.equal(whileArchived.status, 404);
    assert.equal(JSON.parse(whileArchived.body).error, "not_tracked");
  } finally {
    await fixture.close();
  }
});

// #279 — a room opened by its own URL (invite link, bookmark) holds no capability,
// which is why its history never reached the dashboard at all. It names its own
// room instead, and the name is honoured only under the origin the browser reports.
test("a capability-less room contributes history only for a room under its own origin (#279)", async () => {
  const root = await makeRoot();
  const roomBaseUrl = "http://127.0.0.1:9";
  await seedJoinedRoom(root, "snap-room", roomBaseUrl);
  await seedJoinedRoom(root, "other-room", "http://127.0.0.1:8");
  const fixture = await startServer(root, "owner-1");
  try {
    // No capability at all — the direct-open case. Origin matches the room it names.
    const accepted = await postJoinedHistory(
      fixture.baseUrl,
      roomBaseUrl,
      JSON.stringify({
        roomId: "snap-room",
        baseUrl: roomBaseUrl,
        messages: [{ id: 1, from: "project7", ts: "", type: "chat", text: "direct open landed" }]
      })
    );
    assert.equal(accepted.status, 200);
    const stored = (await (
      await fetch(`${fixture.baseUrl}/joined-rooms/history?room_id=snap-room&base_url=${encodeURIComponent(roomBaseUrl)}`)
    ).json()) as { snapshot: { messages: Array<{ text: string }> } | null };
    assert.equal(stored.snapshot?.messages[0]?.text, "direct open landed");

    // The same request naming a room served by a DIFFERENT origin is refused: the
    // browser sets Origin, so a page cannot reach past the host that served it.
    const crossRoom = await postJoinedHistory(
      fixture.baseUrl,
      roomBaseUrl,
      JSON.stringify({
        roomId: "other-room",
        baseUrl: "http://127.0.0.1:8",
        messages: [{ id: 2, from: "project7", ts: "", type: "chat", text: "should not land" }]
      })
    );
    assert.equal(crossRoom.status, 403);
    const other = (await (
      await fetch(`${fixture.baseUrl}/joined-rooms/history?room_id=other-room&base_url=${encodeURIComponent("http://127.0.0.1:8")}`)
    ).json()) as { snapshot: unknown };
    assert.equal(other.snapshot, null, "a page cannot contribute history for another origin's room");

    // An untracked room stays untargetable by this path too — the property the
    // capability existed to give is not weakened by removing the capability.
    const untracked = await postJoinedHistory(
      fixture.baseUrl,
      roomBaseUrl,
      JSON.stringify({
        roomId: "never-tracked",
        baseUrl: roomBaseUrl,
        messages: [{ id: 3, from: "project7", ts: "", type: "chat", text: "no row for this" }]
      })
    );
    assert.equal(untracked.status, 404);
  } finally {
    await fixture.close();
  }
});
