import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";

// #146: host-create/invite `--json` responses are token-free and invite-URL-free
// by default; `--show-token` opts in for programmatic use. `room current --json`
// stays the host token-retrieval path. Applied consistently to room start,
// room invite, and room create-boardroom (already token-free per #144).

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
  reset(): void {
    this.chunks = [];
  }
}

async function makeContext(): Promise<{ context: CliContext; stdout: Capture }> {
  const stdout = new Capture();
  return {
    context: { home: await mkdtemp(path.join(os.tmpdir(), "agentgather-146-")), stdout, stderr: new Capture() },
    stdout
  };
}

test("room start --json is token-free by default and opts in with --show-token", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["start", "r1", "--alias", "host", "--json"], context);
  const out = stdout.json<{ ok: true; room: string; alias: string; kind: string; baseUrl: string; token?: string }>();
  assert.equal(out.room, "r1");
  assert.equal(out.alias, "host");
  assert.equal(out.token, undefined, "default room start --json must not carry the raw token");
  assert.equal(stdout.text().includes("tgl_"), false, "default room start --json must not contain a tgl_ token");

  stdout.reset();
  await runRoomCommand(["start", "r2", "--alias", "host", "--show-token", "--json"], context);
  const shown = stdout.json<{ token: string }>();
  assert.match(shown.token, /^tgl_/, "--show-token surfaces the raw token for programmatic use");
});

test("room invite --json is token-free and invite-URL-free by default and opts in with --show-token", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["start", "r1", "--alias", "host", "--json"], context);

  stdout.reset();
  await runRoomCommand(["invite", "reviewer", "--kind", "agent", "--json"], context);
  const out = stdout.json<{
    ok: true;
    room: string;
    alias: string;
    kind: string;
    token?: string;
    card_command?: string;
    browser_url?: string;
  }>();
  assert.equal(out.alias, "reviewer");
  assert.equal(out.kind, "agent");
  assert.equal(out.token, undefined, "default room invite --json must not carry the raw token");
  assert.equal(out.card_command, undefined, "default room invite --json must not carry the token-bearing card command");
  assert.equal(out.browser_url, undefined, "default room invite --json must not carry the #token= invite URL");
  assert.equal(stdout.text().includes("tgl_"), false, "default room invite --json must not contain a tgl_ token");

  stdout.reset();
  await runRoomCommand(["invite", "auditor", "--kind", "agent", "--show-token", "--json"], context);
  const shown = stdout.json<{ token: string; card_command: string; browser_url: string }>();
  assert.match(shown.token, /^tgl_/);
  assert.equal(shown.card_command.includes(`token=${shown.token}`), true);
  assert.match(shown.browser_url, /#token=tgl_/);
});

test("room create-boardroom --json stays token-free (#144), consistent with start/invite defaults", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["create-boardroom", "board", "--channels", "general:chat", "--json"], context);
  const out = stdout.json<{ ok: true; room: string; token?: string }>();
  assert.equal(out.token, undefined, "create-boardroom --json must remain token-free");
  assert.equal(stdout.text().includes("tgl_"), false, "create-boardroom --json must not contain a tgl_ token");
});

test("room current --json remains the host token-retrieval path after a token-free start", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["start", "r1", "--alias", "host", "--json"], context);
  assert.equal(stdout.text().includes("tgl_"), false);

  stdout.reset();
  await runRoomCommand(["current", "--json"], context);
  const out = stdout.json<{ ok: true; current: { token: string; roomId: string; alias: string } }>();
  assert.match(out.current.token, /^tgl_/, "room current --json exposes the host token for retrieval");
  assert.equal(out.current.roomId, "r1");
});
