import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRoom,
  readBoardroom,
  readChannelCursor,
  roomPaths,
  writeBoardroom,
  writeChannelCursor,
  writeCursor
} from "../src/storage/index.js";
import { DEFAULT_CHANNEL_ID, type Boardroom } from "../src/protocol/index.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-boardroom-"));
}

const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

test("a legacy bare room reads as a #general boardroom at runtime with no migration", async () => {
  const root = await makeRoot();
  await createRoom({
    root,
    roomId: "legacy",
    hostAlias: "host",
    now: new Date("2026-06-21T00:00:00.000Z")
  });
  const boardroom = await readBoardroom(root, "legacy");

  assert.equal(boardroom.legacy, true);
  assert.equal(boardroom.id, "legacy");
  assert.equal(boardroom.channels.length, 1);
  assert.equal(boardroom.channels[0]?.id, DEFAULT_CHANNEL_ID);
  assert.equal(boardroom.channels[0]?.type, "chat");

  // No migration: nothing was written to the room directory.
  const paths = roomPaths(root, "legacy");
  assert.equal(await exists(paths.boardroom), false, "legacy projection must not write boardroom.json");
  assert.equal(await exists(paths.channelCursors), false);
});

test("writeBoardroom persists a multi-channel boardroom (chat + forum), readBoardroom round-trips it", async () => {
  const root = await makeRoot();
  await createRoom({ root, roomId: "br", hostAlias: "host", now: new Date("2026-06-21T00:00:00.000Z") });
  const boardroom: Boardroom = {
    id: "br",
    name: "Engineering",
    channels: [
      { id: "general", name: "general", type: "chat", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" },
      { id: "rfcs", name: "rfcs", type: "forum", lifecycle: "idle", createdAt: "2026-06-21T00:00:00.000Z" }
    ],
    lifecycle: "active",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    legacy: true
  };
  const written = await writeBoardroom(root, "br", boardroom);
  assert.equal(written.legacy, false, "persisted boardroom is not legacy");

  const read = await readBoardroom(root, "br");
  assert.equal(read.legacy, false);
  assert.equal(read.channels.length, 2);
  assert.equal(read.channels.find((c) => c.id === "rfcs")?.type, "forum");

  // Host-owned SSOT: persisted as 0600 JSON with no message bodies inside.
  const paths = roomPaths(root, "br");
  const raw = await readFile(paths.boardroom, "utf8");
  assert.equal(raw.includes("messages"), false);
  assert.equal(raw.includes("text"), false);
});

test("writeBoardroom rejects invalid channels", async () => {
  const root = await makeRoot();
  await createRoom({ root, roomId: "bad", hostAlias: "host" });
  await assert.rejects(
    writeBoardroom(root, "bad", {
      id: "bad",
      channels: [{ id: "ok", name: "ok", type: "video" as never, lifecycle: "active", createdAt: "t" }],
      lifecycle: "active",
      createdAt: "t",
      updatedAt: "t",
      legacy: false
    })
  );
});

test("per-channel read cursors round-trip and are independent across channels", async () => {
  const root = await makeRoot();
  await createRoom({ root, roomId: "cur", hostAlias: "host" });

  assert.equal(await readChannelCursor(root, "cur", "rfcs", "reviewer"), 0);
  await writeChannelCursor(root, "cur", "rfcs", "reviewer", 12, new Date("2026-06-21T00:00:00.000Z"));
  await writeChannelCursor(root, "cur", "general", "reviewer", 4, new Date("2026-06-21T00:00:00.000Z"));

  assert.equal(await readChannelCursor(root, "cur", "rfcs", "reviewer"), 12);
  assert.equal(await readChannelCursor(root, "cur", "general", "reviewer"), 4);

  // Cursor files hold only read-position metadata — no message bodies.
  const paths = roomPaths(root, "cur");
  const raw = await readFile(path.join(paths.channelCursors, "rfcs", "reviewer.json"), "utf8");
  const record = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ["channelId", "participantId", "sinceId", "updatedAt"]);
});

test("the #general channel cursor falls back to a legacy per-alias cursor (no migration)", async () => {
  const root = await makeRoot();
  await createRoom({ root, roomId: "compat", hostAlias: "host" });
  // A pre-existing room has only the legacy alias cursor.
  await writeCursor(root, "compat", "reviewer", 7);

  // Reading the default channel cursor surfaces the legacy read position.
  assert.equal(await readChannelCursor(root, "compat", DEFAULT_CHANNEL_ID, "reviewer"), 7);
  // A non-default channel does not inherit it.
  assert.equal(await readChannelCursor(root, "compat", "rfcs", "reviewer"), 0);
});

test("concurrent writeBoardroom calls serialize under the writer lock and leave valid JSON", async () => {
  const root = await makeRoot();
  await createRoom({ root, roomId: "race", hostAlias: "host" });
  const make = (name: string): Boardroom => ({
    id: "race",
    name,
    channels: [{ id: "general", name: "general", type: "chat", lifecycle: "active", createdAt: "t" }],
    lifecycle: "active",
    createdAt: "t",
    updatedAt: "t",
    legacy: false
  });
  await Promise.all([
    writeBoardroom(root, "race", make("a")),
    writeBoardroom(root, "race", make("b")),
    writeBoardroom(root, "race", make("c"))
  ]);
  const read = await readBoardroom(root, "race");
  assert.equal(read.channels.length, 1);
  assert.ok(["a", "b", "c"].includes(read.name ?? ""));
});
