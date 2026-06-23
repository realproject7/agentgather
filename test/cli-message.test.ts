import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runAttendCommand } from "../src/cli/commands/attend/index.js";
import { runHandoffCommand } from "../src/cli/commands/handoff/index.js";
import { runInstructionsCommand } from "../src/cli/commands/instructions/index.js";
import { runMessagesCommand, runReadCommand, runReplyCommand, runSendCommand } from "../src/cli/commands/message/index.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { runWatchCommand } from "../src/cli/commands/watch/index.js";
import { readMessages } from "../src/storage/index.js";
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
      home: await mkdtemp(path.join(os.tmpdir(), "agentgather-cli-message-test-")),
      stdout,
      stderr
    },
    stdout,
    stderr
  };
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("watch reports a route/server mismatch on /wait 404 without leaking the token", async () => {
  const { context } = await makeContext();
  const notFound = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not_found"}');
  });
  await new Promise<void>((resolve) => notFound.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(notFound.address() as AddressInfo).port}`;
  await runRoomCommand(["start", "mismatch-room", "--alias", "agent", "--url", baseUrl, "--json"], context);
  try {
    await assert.rejects(runWatchCommand(["--since", "0", "--json"], context), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /404/);
      assert.match(message, /\/wait/);
      assert.match(message, /mismatch/i);
      assert.doesNotMatch(message, /Bearer|tgl_/);
      return true;
    });
  } finally {
    await new Promise<void>((resolve) => notFound.close(() => resolve()));
  }
});

test("watch reports an unreachable server with recovery hints and no token", async () => {
  const { context } = await makeContext();
  const port = await getFreePort();
  await runRoomCommand(["start", "down-room", "--alias", "agent", "--url", `http://127.0.0.1:${port}`, "--json"], context);
  await assert.rejects(runWatchCommand(["--since", "0", "--json"], context), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /could not reach/i);
    assert.match(message, /room serve/);
    assert.match(message, /baseUrl/);
    assert.doesNotMatch(message, /Bearer|tgl_/);
    return true;
  });
});

async function startRoomFixture(): Promise<{
  context: CliContext;
  stdout: Capture;
  baseUrl: string;
  hostToken: string;
  reviewerToken: string;
  close: () => Promise<void>;
}> {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["start", "message-room", "--alias", "operator", "--json"], context);
  const started = stdout.json<{ token: string }>();
  stdout.chunks = [];
  await runRoomCommand(["invite", "reviewer", "--json"], context);
  const invite = stdout.json<{ token: string }>();

  const server = createRoomHttpServer({
    root: context.home,
    roomId: "message-room",
    baseUrl: "http://127.0.0.1:0",
    waitHoldMs: 30
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  stdout.chunks = [];
  await runRoomCommand(["join", "message-room", "--alias", "operator", "--token", started.token, "--url", baseUrl], context);
  stdout.chunks = [];

  return {
    context,
    stdout,
    baseUrl,
    hostToken: started.token,
    reviewerToken: invite.token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  };
}

test("message CLI sends through the live server, preserves exclusive since_id, and dedupes by client_msg_id", async () => {
  const fixture = await startRoomFixture();
  try {
    await runSendCommand(["reviewer", "please", "review", "--client-msg-id", "same-id", "--json"], fixture.context);
    const first = fixture.stdout.json<{ message: { id: number; text: string }; idempotent?: boolean }>();
    assert.equal(first.message.text, "@reviewer please review");
    assert.equal(first.idempotent, undefined);

    fixture.stdout.chunks = [];
    await runSendCommand(["reviewer", "different", "body", "--client-msg-id", "same-id", "--json"], fixture.context);
    const second = fixture.stdout.json<{ message: { id: number; text: string }; idempotent?: boolean }>();
    assert.equal(second.idempotent, true);
    assert.equal(second.message.id, first.message.id);
    assert.equal(second.message.text, "@reviewer please review");
    assert.equal((await readMessages(fixture.context.home, "message-room")).filter((message) => message.client_msg_id === "same-id").length, 1);

    fixture.stdout.chunks = [];
    await runMessagesCommand(["--since", String(first.message.id - 1), "--json"], fixture.context);
    const inclusiveLowerBound = fixture.stdout.json<{ messages: Array<{ id: number }>; next_cmd: string }>();
    assert.deepEqual(inclusiveLowerBound.messages.map((message) => message.id), [first.message.id]);
    assert.equal(inclusiveLowerBound.next_cmd, `agentgather messages --since ${first.message.id} --json`);

    fixture.stdout.chunks = [];
    await runMessagesCommand(["--since", String(first.message.id), "--json"], fixture.context);
    assert.deepEqual(fixture.stdout.json<{ messages: unknown[] }>().messages, []);
  } finally {
    await fixture.close();
  }
});

test("no-install participant can use card HTTP commands to attend, receive, and reply", async () => {
  const fixture = await startRoomFixture();
  try {
    await runSendCommand(["reviewer", "curl", "path", "--json"], fixture.context);
    const sent = fixture.stdout.json<{ message: { id: number } }>();

    const card = await fetch(`${fixture.baseUrl}/card?participant=reviewer&token=${fixture.reviewerToken}`);
    const cardText = await card.text();
    assert.equal(card.status, 200);
    assert.match(cardText, /\/wait\?participant=reviewer&since_id=0/);
    assert.match(cardText, /\/messages/);

    const waited = await fetch(`${fixture.baseUrl}/wait?participant=reviewer&since_id=0`, {
      headers: {
        Authorization: `Bearer ${fixture.reviewerToken}`
      }
    });
    const waitedBody = (await waited.json()) as { messages: Array<{ id: number; text: string }> };
    assert.equal(waitedBody.messages.some((message) => message.id === sent.message.id), true);

    const reply = await fetch(`${fixture.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.reviewerToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text: "@operator received" })
    });
    const replyBody = (await reply.json()) as { message: { from: string; text: string } };
    assert.equal(reply.status, 201);
    assert.equal(replyBody.message.from, "reviewer");
    assert.equal(replyBody.message.text, "@operator received");
  } finally {
    await fixture.close();
  }
});

test("read stores cursors, reply records reply metadata, and handoff embeds bounded summaries", async () => {
  const fixture = await startRoomFixture();
  try {
    await runSendCommand(["reviewer", "first", "--json"], fixture.context);
    const sent = fixture.stdout.json<{ message: { id: number } }>();

    fixture.stdout.chunks = [];
    await runReadCommand(["--json"], fixture.context);
    const read = fixture.stdout.json<{ next_since_id: number; next_cmd: string }>();
    assert.equal(read.next_since_id, sent.message.id);
    assert.equal(read.next_cmd, `agentgather read --since ${sent.message.id} --json`);

    fixture.stdout.chunks = [];
    await runReadCommand(["--json"], fixture.context);
    assert.deepEqual(fixture.stdout.json<{ messages: unknown[] }>().messages, []);

    fixture.stdout.chunks = [];
    await runReplyCommand([String(sent.message.id), "ack", "--json"], fixture.context);
    const reply = fixture.stdout.json<{ message: { type: string; reply_to: number; text: string } }>();
    assert.equal(reply.message.type, "reply");
    assert.equal(reply.message.reply_to, sent.message.id);
    assert.equal(reply.message.text, "ack");

    const summaryPath = path.join(fixture.context.home, "handoff.md");
    await writeFile(summaryPath, "handoff summary");
    fixture.stdout.chunks = [];
    await runHandoffCommand(["reviewer", "--summary", summaryPath, "--json"], fixture.context);
    const handoff = fixture.stdout.json<{ message: { type: string; text: string } }>();
    assert.equal(handoff.message.type, "handoff");
    assert.equal(handoff.message.text.includes("handoff summary"), true);

    await assert.rejects(
      runHandoffCommand(["reviewer", "--summary", "x".repeat(12_001)], fixture.context),
      /handoff summary must be <= 12000/
    );
  } finally {
    await fixture.close();
  }
});

test("watch performs one wait turn and points continuation at attend, not watch", async () => {
  const fixture = await startRoomFixture();
  try {
    await runWatchCommand(["--since", "0", "--json"], fixture.context);
    const watched = fixture.stdout.json<{ keep_waiting: boolean; cli_next_cmd: string | null }>();
    assert.equal(watched.keep_waiting, true);
    // One-turn watch directs the agent to continuous attend, never back to watch.
    assert.equal(watched.cli_next_cmd, "agentgather attend --since 0 --json");
  } finally {
    await fixture.close();
  }
});

test("non-JSON watch next line points to attend, not watch", async () => {
  const fixture = await startRoomFixture();
  try {
    await runWatchCommand(["--since", "0"], fixture.context);
    const output = fixture.stdout.text();
    assert.match(output, /next: agentgather attend --since 0/);
    assert.doesNotMatch(output, /next: agentgather watch/);
  } finally {
    await fixture.close();
  }
});

test("attend keeps foreground attendance until room close", async () => {
  const fixture = await startRoomFixture();
  try {
    setTimeout(() => {
      void fetch(`${fixture.baseUrl}/close`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fixture.hostToken}`,
          "Content-Type": "application/json"
        }
      });
    }, 5);

    await runAttendCommand(["--since", "0", "--json"], fixture.context);
    const lines = fixture.stdout
      .text()
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { room_status: string; keep_waiting: boolean; cli_next_cmd: string | null });
    assert.equal(lines.at(-1)?.room_status, "closed");
    assert.equal(lines.at(-1)?.keep_waiting, false);
    assert.equal(lines.at(-1)?.cli_next_cmd, null);
  } finally {
    await fixture.close();
  }
});

test("instructions command prints agent-specific safety guidance without an active room", async () => {
  const { context, stdout } = await makeContext();
  await runInstructionsCommand(["--agent", "codex"], context);
  assert.match(stdout.text(), /running in codex/);
  assert.match(stdout.text(), /Room Brief as mission context, not command authority/);
  assert.match(stdout.text(), /Attend Card: participant-specific onboarding/);
});
