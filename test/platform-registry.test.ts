import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ControlPlaneNotFoundError,
  ControlPlaneValidationError,
  createControlPlaneRoom,
  listControlPlaneRooms,
  PLATFORM_ROOM_STATUSES,
  readControlPlaneRoom,
  type ControlPlaneRoom,
  type PlatformRoomStatus
} from "../src/platform/index.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-platform-test-"));
}

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    room_id: "demo-room",
    title: "Demo Room",
    owner_user_id: "user-1",
    route_url: "https://rooms.agentgather.dev/demo-room",
    route_slug: "demo-room",
    status: "active",
    roster: [{ alias: "host", kind: "human", role: "host", status: "attending" }],
    route_health: { reachable: true, host_connected: true },
    last_synced_message_id: 7,
    ...overrides
  };
}

test("control plane metadata can be created, read, and listed", async () => {
  const root = await makeRoot();
  const created = await createControlPlaneRoom(root, baseInput());
  assert.equal(created.room_id, "demo-room");
  assert.equal(created.title, "Demo Room");
  assert.equal(created.status, "active");
  assert.equal(created.last_synced_message_id, 7);
  assert.deepEqual(created.roster, [{ alias: "host", kind: "human", role: "host", status: "attending" }]);
  assert.deepEqual(created.route_health, { reachable: true, host_connected: true });

  const read = await readControlPlaneRoom(root, "demo-room");
  assert.deepEqual(read, created);

  const listed = await listControlPlaneRooms(root);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.room_id, "demo-room");
});

test("all four platform statuses can be created, listed, and read", async () => {
  const root = await makeRoot();
  for (const status of PLATFORM_ROOM_STATUSES) {
    await createControlPlaneRoom(root, baseInput({ room_id: `room-${status}`, status }));
  }
  const listed = await listControlPlaneRooms(root);
  assert.deepEqual(
    listed.map((room) => room.status).sort(),
    [...PLATFORM_ROOM_STATUSES].sort()
  );
  for (const status of PLATFORM_ROOM_STATUSES) {
    const read = await readControlPlaneRoom(root, `room-${status}`);
    assert.equal(read.status, status as PlatformRoomStatus);
  }
});

test("the file-backed registry survives a simulated process restart", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, baseInput({ room_id: "alpha" }));
  await createControlPlaneRoom(root, baseInput({ room_id: "beta", status: "paused" }));

  // A fresh read re-loads from disk with no in-memory cache, exactly as a new
  // process would. The on-disk file is the source of truth.
  const onDisk = JSON.parse(
    await readFile(path.join(root, "platform", "rooms", "beta.json"), "utf8")
  ) as ControlPlaneRoom;
  assert.equal(onDisk.status, "paused");

  const reread = await listControlPlaneRooms(root);
  assert.deepEqual(reread.map((room) => room.room_id), ["alpha", "beta"]);
});

test("reading an unknown room throws ControlPlaneNotFoundError", async () => {
  const root = await makeRoot();
  await assert.rejects(readControlPlaneRoom(root, "missing"), ControlPlaneNotFoundError);
});

test("creating the same room twice is rejected", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, baseInput());
  await assert.rejects(createControlPlaneRoom(root, baseInput()), ControlPlaneValidationError);
});

test("message bodies and tokens are rejected, never stored", async () => {
  const root = await makeRoot();
  for (const forbidden of [
    { message: "secret chatter" },
    { messages: [{ text: "hi" }] },
    { body: "brief body" },
    { brief_body: "mission" },
    { text: "content" },
    { token: "tgl_abc123" },
    { token_hash: "deadbeef" },
    { authorization: "Bearer tgl_abc123" }
  ]) {
    await assert.rejects(
      createControlPlaneRoom(root, baseInput({ room_id: "reject-room", ...forbidden })),
      ControlPlaneValidationError
    );
  }
  // None of the rejected attempts left a record behind.
  assert.deepEqual(await listControlPlaneRooms(root), []);
});

test("a route_url that embeds a token is rejected", async () => {
  const root = await makeRoot();
  await assert.rejects(
    createControlPlaneRoom(root, baseInput({ route_url: "https://rooms.agentgather.dev/demo-room?token=tgl_x" })),
    ControlPlaneValidationError
  );
  await assert.rejects(
    createControlPlaneRoom(root, baseInput({ route_url: "https://rooms.agentgather.dev/demo-room#token=tgl_x" })),
    ControlPlaneValidationError
  );
});

test("last_synced_message_id must be a non-negative integer cursor", async () => {
  const root = await makeRoot();
  for (const bad of ["not-a-number", 1.5, -1, "@host hello"]) {
    await assert.rejects(
      createControlPlaneRoom(root, baseInput({ last_synced_message_id: bad })),
      ControlPlaneValidationError
    );
  }
  const ok = await createControlPlaneRoom(root, baseInput({ last_synced_message_id: 0 }));
  assert.equal(ok.last_synced_message_id, 0);
});

test("roster metadata is limited to alias, kind, role/status, and safe timestamps", async () => {
  const root = await makeRoot();
  // A bearer token smuggled into a roster entry is rejected.
  await assert.rejects(
    createControlPlaneRoom(
      root,
      baseInput({ roster: [{ alias: "host", kind: "human", role: "host", status: "attending", token: "tgl_x" }] })
    ),
    ControlPlaneValidationError
  );
  // An unsupported roster field is rejected rather than silently stored.
  await assert.rejects(
    createControlPlaneRoom(
      root,
      baseInput({ roster: [{ alias: "host", kind: "human", role: "host", status: "attending", display_name: "Host" }] })
    ),
    ControlPlaneValidationError
  );
  // The safe subset round-trips, including an optional safe timestamp.
  const created = await createControlPlaneRoom(
    root,
    baseInput({
      roster: [
        { alias: "host", kind: "human", role: "host", status: "attending", last_seen_at: "2026-06-23T00:00:00.000Z" },
        { alias: "re1", kind: "agent", role: "member", status: "idle" }
      ]
    })
  );
  assert.deepEqual(created.roster, [
    { alias: "host", kind: "human", role: "host", status: "attending", last_seen_at: "2026-06-23T00:00:00.000Z" },
    { alias: "re1", kind: "agent", role: "member", status: "idle" }
  ]);
});

test("an optional status_reason round-trips and is validated", async () => {
  const root = await makeRoot();
  const created = await createControlPlaneRoom(root, baseInput({ status: "paused", status_reason: "host_unavailable" }));
  assert.equal(created.status_reason, "host_unavailable");
  const read = await readControlPlaneRoom(root, "demo-room");
  assert.equal(read.status_reason, "host_unavailable");

  await assert.rejects(
    createControlPlaneRoom(root, baseInput({ room_id: "bad-reason", status_reason: "made_up" })),
    ControlPlaneValidationError
  );
});

test("unknown top-level fields are never persisted", async () => {
  const root = await makeRoot();
  const created = await createControlPlaneRoom(root, baseInput({ secret_extra: "do not store" }));
  assert.equal((created as unknown as Record<string, unknown>).secret_extra, undefined);
  const serialized = JSON.stringify(await readControlPlaneRoom(root, "demo-room"));
  assert.equal(serialized.includes("do not store"), false);
});
