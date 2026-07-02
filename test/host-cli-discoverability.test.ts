import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { buildHelpText } from "../src/cli/help.js";
import { readBoardroom } from "../src/storage/index.js";
import { createRoomHttpServer } from "../src/server/index.js";
import { readToken } from "../src/cli/state.js";
import { parseChannelName, type Boardroom } from "../src/protocol/index.js";

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

async function makeContext(): Promise<{ context: CliContext; stdout: Capture }> {
  const stdout = new Capture();
  return {
    context: { home: await mkdtemp(path.join(os.tmpdir(), "agentgather-168-")), stdout, stderr: new Capture() },
    stdout
  };
}

// ---- (a) help discoverability ----

test("top-level help lists the boardroom/channel/forum host commands", () => {
  const help = buildHelpText();
  assert.match(help, /room create-boardroom/);
  assert.match(help, /room boardroom \[--json\]/);
  assert.match(help, /room channel-create <channel>/);
  assert.match(help, /room channel-rename <channel> --name <display>/);
  assert.match(help, /room channel-read \[channel\]/);
  assert.match(help, /room forum-post <channel> --title/);
  assert.match(help, /room forum-comment <channel> <post>/);
  assert.match(help, /room forum-list <channel>/);
  assert.match(help, /room forum-read <channel> <post>/);
  assert.match(help, /room forum-status <channel> <post>/);
  // Privacy: help is static usage text and must not carry tokens or invite URLs.
  assert.doesNotMatch(help, /tgl_/);
  assert.doesNotMatch(help, /#token=/);
});

// ---- parseChannelName validation ----

test("parseChannelName trims/collapses and rejects empty, over-long, and control-char names", () => {
  assert.equal(parseChannelName("  Ops   Room  "), "Ops Room");
  assert.throws(() => parseChannelName("   "));
  assert.throws(() => parseChannelName("x".repeat(61)));
  assert.throws(() => parseChannelName("badname"));
});

// ---- (b/c) channel-rename via CLI + /boardroom metadata persistence ----

test("room channel-rename updates the display name via the store, id unchanged, persisted to /boardroom", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(
    ["create-boardroom", "ag-project", "--channels", "general:chat,design:forum", "--json"],
    context
  );

  // Rename a created channel's display name; the channel id stays the same.
  stdout.chunks = [];
  await runRoomCommand(["channel-rename", "general", "--name", "Ops Room", "--json"], context);
  const renamed = stdout.json<{ ok: true; channel: { id: string; name: string; type: string } }>();
  assert.equal(renamed.channel.id, "general");
  assert.equal(renamed.channel.name, "Ops Room");
  assert.equal(renamed.channel.type, "chat");

  // Persisted host-owned metadata reflects the new name; id/type/count unchanged.
  const persisted = await readBoardroom(context.home, "ag-project");
  const general = persisted.channels.find((c) => c.id === "general");
  assert.equal(general?.name, "Ops Room");
  assert.equal(general?.type, "chat");
  assert.equal(persisted.channels.length, 2);
  assert.equal(persisted.legacy, false);

  // The rename surfaces through the HTTP /boardroom metadata endpoint.
  const server = createRoomHttpServer({
    root: context.home,
    roomId: "ag-project",
    baseUrl: "http://127.0.0.1:0",
    rateLimitPerMinute: 1000
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // /boardroom requires any valid participant; use the host token persisted by
    // the create flow (host-owned local state).
    const hostToken = await readToken(context.home, "ag-project", "host");
    const response = await fetch(`${baseUrl}/boardroom`, { headers: { Authorization: `Bearer ${hostToken}` } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: true; boardroom: Boardroom };
    assert.equal(body.boardroom.channels.find((c) => c.id === "general")?.name, "Ops Room");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("room channel-rename rejects unknown channel and invalid name; channel-create stays compatible", async () => {
  const { context } = await makeContext();
  await runRoomCommand(["create-boardroom", "ag-project2", "--json"], context);

  await assert.rejects(() => runRoomCommand(["channel-rename", "nope", "--name", "X", "--json"], context));
  await assert.rejects(() => runRoomCommand(["channel-rename", "general", "--json"], context)); // missing --name
  await assert.rejects(() => runRoomCommand(["channel-rename", "general", "--name", "   ", "--json"], context));

  // Existing channel-create remains compatible after the rename flow was added.
  await runRoomCommand(["channel-create", "ops-forum", "--type", "forum", "--json"], context);
  const board = await readBoardroom(context.home, "ag-project2");
  assert.equal(board.channels.some((c) => c.id === "ops-forum" && c.type === "forum"), true);
});
