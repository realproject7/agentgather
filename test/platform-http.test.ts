import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { request, type Server } from "node:http";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlatformHttpServer } from "../src/platform/index.js";
import { createControlPlaneRoom } from "../src/platform/index.js";
import { appendServerMessage, createRoom } from "../src/storage/index.js";

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
