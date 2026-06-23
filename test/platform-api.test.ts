import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlPlaneRoom, listRoomsResponse, readRoomResponse } from "../src/platform/index.js";

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
