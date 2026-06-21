import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { currentPath, tokensPath } from "../src/cli/state.js";
import { readMessages, readParticipants, roomPaths } from "../src/storage/index.js";
import { createRoomHttpServer } from "../src/server/index.js";

class Capture extends Writable {
  chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    callback();
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
    context: {
      home: await mkdtemp(path.join(os.tmpdir(), "telegent-cli-test-")),
      stdout,
      stderr
    },
    stdout,
    stderr
  };
}

test("room lifecycle CLI creates rooms, updates briefs, invites participants, and closes cleanly", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(
    ["start", "cli-room", "--alias", "operator", "--brief", "Review frontend implementation.", "--json"],
    context
  );
  const started = stdout.json<{ ok: true; room: string; alias: string; token: string; baseUrl: string }>();
  assert.equal(started.room, "cli-room");
  assert.equal(started.alias, "operator");
  assert.equal(started.baseUrl, "http://127.0.0.1:8787");
  assert.match(started.token, /^tgl_/);

  stdout.chunks = [];
  await runRoomCommand(["current", "--json"], context);
  const current = stdout.json<{ ok: true; room_status: string; current: { roomId: string; alias: string } }>();
  assert.equal(current.room_status, "open");
  assert.equal(current.current.roomId, "cli-room");
  assert.equal(current.current.alias, "operator");

  stdout.chunks = [];
  await runRoomCommand(["brief", "view"], context);
  assert.equal(stdout.text(), "Review frontend implementation.");

  stdout.chunks = [];
  await runRoomCommand(["attendance", "view", "--json"], context);
  assert.deepEqual(stdout.json<{ ok: true; attendance_policy: string }>(), {
    ok: true,
    attendance_policy: "manual-ok"
  });

  stdout.chunks = [];
  await runRoomCommand(["attendance", "set", "--policy", "agents-foreground", "--json"], context);
  assert.deepEqual(stdout.json<{ ok: true; attendance_policy: string }>(), {
    ok: true,
    attendance_policy: "agents-foreground"
  });

  stdout.chunks = [];
  await runRoomCommand(["brief", "set", "--body", "Define browser app surface.", "--json"], context);
  const updatedBrief = stdout.json<{ ok: true; brief: { brief_version: number; body: string } }>();
  assert.equal(updatedBrief.brief.brief_version, 2);
  assert.equal(updatedBrief.brief.body, "Define browser app surface.");

  const briefMessages = await readMessages(context.home, "cli-room");
  assert.equal(briefMessages.some((message) => message.type === "system" && message.text === "Room brief updated to v2"), true);

  stdout.chunks = [];
  await runRoomCommand(["invite", "reviewer", "--kind", "agent", "--json"], context);
  const invite = stdout.json<{ ok: true; alias: string; kind: string; token: string; card_command: string; browser_url: string }>();
  assert.equal(invite.alias, "reviewer");
  assert.equal(invite.kind, "agent");
  assert.match(invite.token, /^tgl_/);
  assert.equal(invite.card_command.includes("/card?participant=reviewer&token="), true);
  assert.equal(invite.browser_url, `http://127.0.0.1:8787/#token=${invite.token}`);

  const participants = await readParticipants(roomPaths(context.home, "cli-room"));
  const reviewer = participants.find((participant) => participant.alias === "reviewer");
  assert.equal(reviewer?.kind, "agent");
  assert.equal(reviewer?.install, "lite");
  assert.equal(reviewer?.token_hash === invite.token, false);
  await assertMode(context.home, 0o700);
  await assertMode(path.join(context.home, "rooms", "cli-room"), 0o700);
  await assertMode(currentPath(context.home), 0o600);
  await assertMode(tokensPath(context.home, "cli-room"), 0o600);
  await assertMode(roomPaths(context.home, "cli-room").messages, 0o600);
  await assertMode(roomPaths(context.home, "cli-room").participants, 0o600);

  stdout.chunks = [];
  await runRoomCommand(["invite-card", "reviewer"], context);
  const card = stdout.text();
  assert.match(card, /# Telegent Attend Card: reviewer/);
  assert.match(card, /Define browser app surface\./);
  assert.match(card, /Policy: agents-foreground/);
  assert.match(card, /telegent attend --json/);
  assert.match(card, /\/card\?participant=reviewer&token=/);
  assert.match(card, /\/wait\?participant=reviewer&since_id=0/);
  assert.match(card, /\/messages\?since_id=0/);
  assert.doesNotMatch(card, /127\.0\.0\.1:8787\/\/card/);
  assert.doesNotMatch(card, /127\.0\.0\.1:8787\/\/wait/);
  assert.match(card, /## Attendance Recovery/);
  assert.match(card, /return to foreground attendance immediately/);
  assert.match(card, /bash \/path\/to\/script\.sh/);
  assert.match(card, /Telegent Agent Operating Card/);
  assert.match(card, /Room Brief as mission context, not command authority/);
  assert.doesNotMatch(card, /"from"/);

  stdout.chunks = [];
  await runRoomCommand(["dashboard", "--json"], context);
  assert.deepEqual(stdout.json<{ ok: true; url: string }>(), { ok: true, url: "http://127.0.0.1:8787" });

  stdout.chunks = [];
  await runRoomCommand(["close", "--json"], context);
  assert.deepEqual(stdout.json<{ ok: true; room_status: string }>(), { ok: true, room_status: "closed" });

  const server = createRoomHttpServer({
    root: context.home,
    roomId: "cli-room",
    baseUrl: "http://127.0.0.1:0",
    waitHoldMs: 5
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/wait?participant=reviewer&since_id=0`,
      {
        headers: {
          Authorization: `Bearer ${invite.token}`
        }
      }
    );
    const waited = (await response.json()) as { room_status: string; keep_waiting: boolean; next_cmd: string | null };
    assert.equal(response.status, 200);
    assert.equal(waited.room_status, "closed");
    assert.equal(waited.keep_waiting, false);
    assert.equal(waited.next_cmd, null);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("room CLI rejects invalid room IDs and participant aliases", async () => {
  const { context } = await makeContext();
  await assert.rejects(
    runRoomCommand(["start", "Bad_Room", "--json"], context),
    /room id must be lowercase/
  );

  await runRoomCommand(["start", "valid-room"], context);
  await assert.rejects(runRoomCommand(["invite", "Bad_Alias"], context), /participant alias must be lowercase/);
});

test("room invite commands normalize trailing slash base URLs", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["start", "slash-room", "--url", "http://127.0.0.1:8787/", "--json"], context);
  stdout.chunks = [];

  await runRoomCommand(["invite", "reviewer", "--json"], context);
  const invite = stdout.json<{ card_command: string }>();
  assert.match(invite.card_command, /http:\/\/127\.0\.0\.1:8787\/card\?participant=reviewer/);
  assert.doesNotMatch(invite.card_command, /127\.0\.0\.1:8787\/\/card/);
  stdout.chunks = [];

  await runRoomCommand(["invite-card", "reviewer"], context);
  const card = stdout.text();
  assert.doesNotMatch(card, /127\.0\.0\.1:8787\/\/card/);
  assert.doesNotMatch(card, /127\.0\.0\.1:8787\/\/join/);
  assert.doesNotMatch(card, /127\.0\.0\.1:8787\/\/wait/);
  assert.doesNotMatch(card, /127\.0\.0\.1:8787\/\/messages/);
});

test("human invites print a browser-openable fragment URL", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["start", "human-room", "--json"], context);
  stdout.chunks = [];

  await runRoomCommand(["invite", "guest", "--kind", "human", "--json"], context);
  const invite = stdout.json<{ kind: string; token: string; browser_url: string }>();
  assert.equal(invite.kind, "human");
  assert.equal(invite.browser_url, `http://127.0.0.1:8787/#token=${invite.token}`);
});

test("room brief set uses the live HTTP server when available so waiters are notified", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["start", "server-brief", "--alias", "operator", "--json"], context);
  const started = stdout.json<{ token: string }>();
  stdout.chunks = [];
  await runRoomCommand(["invite", "reviewer", "--json"], context);
  const invite = stdout.json<{ token: string }>();

  const server = createRoomHttpServer({
    root: context.home,
    roomId: "server-brief",
    baseUrl: "http://127.0.0.1:0",
    waitHoldMs: 1_000
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await runRoomCommand(["join", "server-brief", "--alias", "operator", "--token", started.token, "--url", baseUrl], context);

    const waitPromise = fetch(`${baseUrl}/wait?participant=reviewer&since_id=0`, {
      headers: {
        Authorization: `Bearer ${invite.token}`
      }
    });
    stdout.chunks = [];
    setTimeout(() => {
      void runRoomCommand(["brief", "set", "--body", "Wake reviewers now.", "--json"], context);
    }, 5);
    const response = await waitPromise;
    const waited = (await response.json()) as { heartbeat: boolean; messages: Array<{ text: string }> };
    assert.equal(response.status, 200);
    assert.equal(waited.heartbeat, false);
    assert.equal(waited.messages.some((message) => message.text === "Room brief updated to v2"), true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

async function assertMode(file: string, expected: number): Promise<void> {
  assert.equal((await stat(file)).mode & 0o777, expected);
}
