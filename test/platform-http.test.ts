import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { request, type Server } from "node:http";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VERSION } from "../src/cli/help.js";
import { createPlatformHttpServer } from "../src/platform/index.js";
import { createControlPlaneRoom } from "../src/platform/index.js";
import { appendServerMessage, createBoardroom, createRoom, recordJoinedRoom } from "../src/storage/index.js";
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
  const fixture = await startServer(root, "owner-1");
  try {
    // A hostile body: a token field + a #token= in the URL. Neither may survive.
    const body = JSON.stringify({
      roomId: "demo",
      title: "Demo",
      alias: "me",
      baseUrl: "http://127.0.0.1:8787/#token=tgl_secret_leak",
      token: "tgl_should_be_dropped"
    });
    const res = await postJoinedRoom(fixture.baseUrl, "http://127.0.0.1:5555", body);
    assert.equal(res.status, 200);
    const list = (await (await fetch(`${fixture.baseUrl}/joined-rooms`)).json()) as {
      rooms: Array<{ baseUrl: string }>;
    };
    assert.equal(list.rooms.length, 1);
    // baseUrl reduced to origin (fragment dropped); no token field anywhere.
    assert.equal(list.rooms[0]?.baseUrl, "http://127.0.0.1:8787");
    assert.equal(/tgl_|"token"|Bearer/i.test(JSON.stringify(list.rooms)), false);
  } finally {
    await fixture.close();
  }
});
