import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import {
  appendMessage,
  createRoom,
  readChannelView,
  roomPaths,
  writeChannelCursor,
  writeParticipants
} from "../src/storage/index.js";
import { participantTokenHash } from "../src/server/index.js";
import { writeCurrent } from "../src/cli/state.js";
import { isBroadcast, summarizeUnread, type Participant } from "../src/protocol/index.js";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";

const mkP = (alias: string, kind: Participant["kind"], token: string): Participant => ({
  alias,
  kind,
  location: "local",
  install: "lite",
  attention: "manual",
  is_host: false,
  token_hash: participantTokenHash(token),
  joinedAt: "2026-06-21T00:00:00.000Z",
  lastSeenAt: "2026-06-21T00:00:00.000Z"
});

async function seedRoom(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-t5-"));
  await createRoom({ root, roomId: "demo", hostAlias: "host" });
  await writeParticipants(root, "demo", [
    { ...mkP("host", "human", "tgl_host"), is_host: true },
    mkP("reviewer", "agent", "tgl_rev")
  ]);
  await appendMessage({ root, roomId: "demo", from: "host", input: { text: "@reviewer please look" } });
  await appendMessage({ root, roomId: "demo", from: "reviewer", input: { text: "on it" } });
  await appendMessage({ root, roomId: "demo", from: "host", input: { text: "release at noon", type: "status" } });
  return root;
}

test("summarizeUnread counts messages past the cursor and tracks the latest id", () => {
  const msgs = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(summarizeUnread(msgs, 0), { unread: 3, latestId: 3 });
  assert.deepEqual(summarizeUnread(msgs, 2), { unread: 1, latestId: 3 });
  assert.deepEqual(summarizeUnread([], 5), { unread: 0, latestId: 5 });
});

test("#general projects the existing message log (no duplicated chat storage)", async () => {
  const root = await seedRoom();
  const view = await readChannelView(root, "demo", "general", "reviewer");
  assert.equal(view.channelId, "general");
  assert.equal(view.type, "chat");
  assert.equal(view.messages.length, 3);
  assert.equal(view.messages[0]?.text, "@reviewer please look");

  // It is a projection: no separate per-channel message store is written.
  const paths = roomPaths(root, "demo");
  assert.equal(view.messages.length, JSON.parse(`[${(await readFile(paths.messages, "utf8")).trim().split("\n").join(",")}]`).length);
});

test("unread/history come from the T3 per-channel cursor (idle inspection)", async () => {
  const root = await seedRoom();
  // Fresh reader: everything is unread.
  let view = await readChannelView(root, "demo", "general", "reviewer");
  assert.equal(view.unread, 3);
  assert.equal(view.lastReadId, 0);

  // Advance the channel cursor → unread shrinks; no message storage changes.
  await writeChannelCursor(root, "demo", "general", "reviewer", view.messages[1]?.id ?? 0);
  view = await readChannelView(root, "demo", "general", "reviewer");
  assert.equal(view.unread, 1);
  assert.equal(view.lastReadId, 2);
});

test("the #general cursor falls back to a legacy per-alias cursor (no migration)", async () => {
  const root = await seedRoom();
  // A pre-boardroom room only has the legacy alias cursor.
  const { writeCursor } = await import("../src/storage/index.js");
  await writeCursor(root, "demo", "reviewer", 1);
  const view = await readChannelView(root, "demo", "general", "reviewer");
  assert.equal(view.lastReadId, 1);
  assert.equal(view.unread, 2);
});

test("broadcast (status) vs directed (mention) visibility is preserved in the projection", async () => {
  const root = await seedRoom();
  const view = await readChannelView(root, "demo", "general", "reviewer");
  const broadcast = view.messages.find((m) => m.text === "release at noon");
  const directed = view.messages.find((m) => m.text === "@reviewer please look");
  assert.ok(broadcast && isBroadcast(broadcast), "status message stays a broadcast");
  assert.ok(directed && !isBroadcast(directed), "mention message stays directed");
  assert.deepEqual(directed?.mentions, ["reviewer"]);
});

test("a non-#general channel has no backing store yet and projects empty", async () => {
  const root = await seedRoom();
  const { addChannel } = await import("../src/storage/index.js");
  await addChannel(root, "demo", { id: "design-forum", name: "design-forum", type: "forum", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" });
  const view = await readChannelView(root, "demo", "design-forum", "reviewer");
  assert.equal(view.type, "forum");
  assert.equal(view.messages.length, 0, "non-#general channel projects empty (no duplicated store in MVP)");
  assert.equal(view.unread, 0);
  // #general still projects the existing log unchanged.
  assert.equal((await readChannelView(root, "demo", "general", "reviewer")).messages.length, 3);
});

// ---- CLI idle read (never enters attended mode) ----

class Capture extends Writable {
  chunks: string[] = [];
  _write(c: Buffer | string, _e: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(c) ? c.toString("utf8") : c);
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
  json<T>(): T {
    return JSON.parse(this.text()) as T;
  }
}

test("room channel-read shows unread/history and --mark-read advances the cursor, without touching attendance", async () => {
  const root = await seedRoom();
  const stdout = new Capture();
  const stderr = new Capture();
  const context: CliContext = { home: root, stdout, stderr };
  await writeCurrent(root, { roomId: "demo", alias: "reviewer", token: "tgl_rev", baseUrl: "http://127.0.0.1:8787" });

  await runRoomCommand(["channel-read", "general", "--json"], context);
  const before = stdout.json<{ unread: number; messages: unknown[]; lastReadId: number }>();
  assert.equal(before.unread, 3);
  assert.equal(before.messages.length, 3);

  stdout.chunks.length = 0;
  await runRoomCommand(["channel-read", "general", "--mark-read", "--json"], context);
  const after = stdout.json<{ unread: number; lastReadId: number }>();
  assert.equal(after.unread, 0);
  assert.equal(after.lastReadId, before.messages.length);

  // Idle read must not have flipped the participant into attended mode.
  const participants = JSON.parse(await readFile(roomPaths(root, "demo").participants, "utf8")) as Participant[];
  assert.equal(participants.find((p) => p.alias === "reviewer")?.attention, "manual");
});
