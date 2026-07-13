import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlPlaneRoom, listRoomsResponse, readRoomResponse } from "../src/platform/index.js";
import { createBoardroom, createRoom } from "../src/storage/index.js";
import type { Channel } from "../src/protocol/index.js";

function channel(overrides: Partial<Channel> & Pick<Channel, "id">): Channel {
  return {
    name: overrides.id,
    type: "chat",
    lifecycle: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

// Materialize a host boardroom store for a room. The room directory must exist
// first (the boardroom store writes under the room's writer lock), so create the
// host room before writing the boardroom.
async function seedBoardroom(root: string, roomId: string, channels: Channel[]): Promise<void> {
  await createRoom({ root, roomId, hostAlias: "host" });
  await createBoardroom(root, roomId, { channels });
}

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-platform-api-test-"));
}

async function seed(root: string): Promise<void> {
  await createControlPlaneRoom(root, {
    room_id: "owned-room",
    title: "Owned",
    owner_user_id: "user-1",
    route_url: "https://rooms.agentgather.dev/owned-room",
    status: "active",
    roster: [{ alias: "host", kind: "human", role: "host", status: "attending" }],
    route_health: { reachable: true, host_connected: true },
    last_synced_message_id: 3
  });
  await createControlPlaneRoom(root, {
    room_id: "other-room",
    title: "Other",
    owner_user_id: "user-2",
    route_url: "https://rooms.agentgather.dev/other-room",
    status: "idle",
    last_synced_message_id: 0
  });
}

test("list returns only the requesting owner's rooms", async () => {
  const root = await makeRoot();
  await seed(root);
  const response = await listRoomsResponse(root, { owner_user_id: "user-1" });
  assert.equal(response.status, 200);
  const body = response.body as { ok: boolean; rooms: Array<{ room_id: string }> };
  assert.equal(body.ok, true);
  assert.deepEqual(body.rooms.map((room) => room.room_id), ["owned-room"]);
});

test("read returns the owner's room metadata", async () => {
  const root = await makeRoot();
  await seed(root);
  const response = await readRoomResponse(root, "owned-room", { owner_user_id: "user-1" });
  assert.equal(response.status, 200);
  const body = response.body as { ok: boolean; room: { room_id: string; status: string } };
  assert.equal(body.room.room_id, "owned-room");
  assert.equal(body.room.status, "active");
});

test("reading another owner's room reports not found, never that it is hidden", async () => {
  const root = await makeRoot();
  await seed(root);
  const response = await readRoomResponse(root, "other-room", { owner_user_id: "user-1" });
  assert.equal(response.status, 404);
});

test("reading a missing room reports not found", async () => {
  const root = await makeRoot();
  await seed(root);
  const response = await readRoomResponse(root, "ghost-room", { owner_user_id: "user-1" });
  assert.equal(response.status, 404);
});

test("an owner-less request is unauthorized, with no anonymous read", async () => {
  const root = await makeRoot();
  await seed(root);
  const list = await listRoomsResponse(root, { owner_user_id: "" });
  assert.equal(list.status, 401);
  const read = await readRoomResponse(root, "owned-room", { owner_user_id: "" });
  assert.equal(read.status, 401);
});

test("API responses never carry tokens, bearer headers, or message content", async () => {
  const root = await makeRoot();
  await seed(root);
  const list = JSON.stringify((await listRoomsResponse(root, { owner_user_id: "user-1" })).body);
  const read = JSON.stringify((await readRoomResponse(root, "owned-room", { owner_user_id: "user-1" })).body);
  for (const serialized of [list, read]) {
    assert.doesNotMatch(serialized, /Bearer|tgl_|token_hash|"message"/);
  }
});

test("hosted rooms carry sanitized channels reduced to exactly id, name, type", async () => {
  const root = await makeRoot();
  await seed(root);
  await seedBoardroom(root, "owned-room", [
    channel({ id: "general", name: "general", type: "chat" }),
    channel({ id: "ideas", name: "Ideas", type: "forum", lifecycle: "idle" })
  ]);
  const expected = [
    { id: "general", name: "general", type: "chat" },
    { id: "ideas", name: "Ideas", type: "forum" }
  ];

  const read = await readRoomResponse(root, "owned-room", { owner_user_id: "user-1" });
  const readBody = read.body as { room: { channels: unknown[] } };
  assert.deepEqual(readBody.room.channels, expected);

  const list = await listRoomsResponse(root, { owner_user_id: "user-1" });
  const listBody = list.body as { rooms: Array<{ room_id: string; channels: unknown[] }> };
  assert.deepEqual(listBody.rooms.find((room) => room.room_id === "owned-room")?.channels, expected);
});

test("removed channels are omitted from the public channel list", async () => {
  const root = await makeRoot();
  await seed(root);
  await seedBoardroom(root, "owned-room", [
    channel({ id: "general", name: "general", type: "chat" }),
    channel({ id: "archived", name: "Archived", type: "forum", lifecycle: "removed" })
  ]);
  const read = await readRoomResponse(root, "owned-room", { owner_user_id: "user-1" });
  const body = read.body as { room: { channels: Array<{ id: string }> } };
  assert.deepEqual(body.room.channels.map((c) => c.id), ["general"]);
});

test("a room without a boardroom store falls back to a single #general chat channel", async () => {
  const root = await makeRoot();
  await seed(root); // no boardroom store is materialized for owned-room
  const read = await readRoomResponse(root, "owned-room", { owner_user_id: "user-1" });
  const body = read.body as { room: { channels: unknown[] } };
  assert.deepEqual(body.room.channels, [{ id: "general", name: "general", type: "chat" }]);
});

test("channel metadata stays owner-scoped: a non-owner gets not_found and no channel leak", async () => {
  const root = await makeRoot();
  await seed(root);
  await seedBoardroom(root, "other-room", [channel({ id: "secret", name: "Secret Ops", type: "forum" })]);
  const read = await readRoomResponse(root, "other-room", { owner_user_id: "user-1" });
  assert.equal(read.status, 404);
  assert.doesNotMatch(JSON.stringify(read.body), /secret/i);
  const list = await listRoomsResponse(root, { owner_user_id: "user-1" });
  assert.doesNotMatch(JSON.stringify(list.body), /secret/i);
});

test("channels are token-free: present but carrying no token, url, lifecycle, or cursor", async () => {
  const root = await makeRoot();
  await seed(root);
  await seedBoardroom(root, "owned-room", [channel({ id: "general", name: "general", type: "chat" })]);
  const read = await readRoomResponse(root, "owned-room", { owner_user_id: "user-1" });
  const body = read.body as { room: { channels: unknown[] } };
  assert.ok(body.room.channels.length > 0); // non-vacuous: channels really are present
  assert.doesNotMatch(JSON.stringify(read.body), /Bearer|tgl_|token_hash|invite|"lifecycle"|"createdAt"|cursor|Authorization/i);
});
