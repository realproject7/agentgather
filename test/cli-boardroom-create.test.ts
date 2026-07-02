import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { readFile } from "node:fs/promises";
import { readBoardroom, readParticipants, roomPaths } from "../src/storage/index.js";
import { participantTokenHash } from "../src/server/index.js";
import { tokensPath } from "../src/cli/state.js";
import { findNameOwnerConflict, type Boardroom } from "../src/protocol/index.js";

class Capture extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
  json<T>(): T {
    return JSON.parse(this.text()) as T;
  }
}

async function makeContext(): Promise<{ context: CliContext; stdout: Capture; stderr: Capture }> {
  const stdout = new Capture();
  const stderr = new Capture();
  return {
    context: { home: await mkdtemp(path.join(os.tmpdir(), "agentgather-t7-")), stdout, stderr },
    stdout,
    stderr
  };
}

test("room create-boardroom creates #general (chat) + #design-forum (forum) choosing type at creation", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(
    ["create-boardroom", "demo", "--name", "Demo", "--channels", "general:chat,design-forum:forum", "--json"],
    context
  );
  const text = stdout.text();
  // #144 gate: the create response must not echo a raw token.
  assert.equal(text.includes("tgl_"), false, "create-boardroom output must not leak a raw token");
  const out = JSON.parse(text) as { ok: true; room: string; boardroom: Boardroom } & { token?: unknown };
  assert.equal(out.room, "demo");
  assert.equal(out.token, undefined, "create-boardroom JSON must not include a token field");
  assert.equal(out.boardroom.legacy, false);
  assert.equal(out.boardroom.name, "Demo");
  assert.deepEqual(
    out.boardroom.channels.map((c) => [c.id, c.type]),
    [["general", "chat"], ["design-forum", "forum"]]
  );

  // Persisted host-owned; readable back.
  const persisted = await readBoardroom(context.home, "demo");
  assert.equal(persisted.channels.length, 2);
  assert.equal(persisted.channels.find((c) => c.id === "design-forum")?.type, "forum");

  // The host token is still persisted to local state (just not echoed).
  const store = JSON.parse(await readFile(tokensPath(context.home, "demo"), "utf8")) as { tokens: Record<string, string> };
  assert.ok(store.tokens.host?.startsWith("tgl_"), "host token must be saved to local state");
});

test("room channel-create adds a typed channel and rejects a duplicate", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["create-boardroom", "demo2", "--json"], context); // defaults to #general chat
  stdout.chunks.length = 0;
  await runRoomCommand(["channel-create", "rfcs", "--type", "forum", "--json"], context);
  const out = stdout.json<{ ok: true; boardroom: Boardroom }>();
  assert.deepEqual(out.boardroom.channels.map((c) => c.id).sort(), ["general", "rfcs"]);
  assert.equal(out.boardroom.channels.find((c) => c.id === "rfcs")?.type, "forum");

  await assert.rejects(runRoomCommand(["channel-create", "rfcs", "--type", "chat", "--json"], context), /already exists/);
});

test("a legacy room (room start) still works and projects to #general; create flow is additive", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["start", "legacy", "--alias", "host", "--show-token", "--json"], context);
  const started = stdout.json<{ ok: true; token: string }>();
  assert.ok(started.token.startsWith("tgl_"));
  // No boardroom.json written by the legacy path; readBoardroom projects #general.
  const boardroom = await readBoardroom(context.home, "legacy");
  assert.equal(boardroom.legacy, true);
  assert.equal(boardroom.channels[0]?.id, "general");
});

test("boardroom view and persisted metadata never carry raw tokens", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["create-boardroom", "secure", "--channels", "general:chat", "--json"], context);
  stdout.chunks.length = 0;
  await runRoomCommand(["boardroom", "--json"], context);
  const view = stdout.text();
  assert.equal(view.includes("tgl_"), false, "boardroom view must not leak a raw token");
  assert.equal(view.includes("token"), false);

  // The host participant stores only a token hash, never the raw token.
  const participants = await readParticipants(roomPaths(context.home, "secure"));
  for (const p of participants) {
    assert.equal((p as { token?: unknown }).token, undefined);
    if (p.token_hash !== undefined) assert.equal(p.token_hash.startsWith("tgl_"), false);
  }
});

test("name ownership: a name is reclaimable only by its owning token", () => {
  const aliceHash = participantTokenHash("tgl_alice");
  const participants = [
    { alias: "p1", display_name: "Alice", token_hash: aliceHash },
    { alias: "p2", display_name: "Bob", token_hash: participantTokenHash("tgl_bob") }
  ];
  // A different token may not take "Alice".
  assert.deepEqual(
    findNameOwnerConflict(participants, "alice", { alias: "p2", tokenHash: participantTokenHash("tgl_bob") }),
    { alias: "p1" }
  );
  // The owning token reclaims "Alice" (reconnect) — no conflict.
  assert.equal(
    findNameOwnerConflict(participants, "Alice", { alias: "p3", tokenHash: aliceHash }),
    undefined
  );
  // A free name is claimable.
  assert.equal(findNameOwnerConflict(participants, "Carol", { alias: "p3", tokenHash: participantTokenHash("x") }), undefined);
});
