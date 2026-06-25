import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { chromium } from "playwright";
import type { CliContext } from "../../src/cli/context.js";
import { runMessagesCommand, runReadCommand, runReplyCommand, runSendCommand } from "../../src/cli/commands/message/index.js";
import { runRoomCommand } from "../../src/cli/commands/room/index.js";
import { runWatchCommand } from "../../src/cli/commands/watch/index.js";
import { createRoomHttpServer } from "../../src/server/index.js";

class Capture extends Writable {
  chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    callback();
  }

  reset(): void {
    this.chunks = [];
  }

  text(): string {
    return this.chunks.join("");
  }

  json<T>(): T {
    return JSON.parse(this.text()) as T;
  }
}

async function makeContext(prefix: string): Promise<{ context: CliContext; stdout: Capture; stderr: Capture }> {
  const stdout = new Capture();
  const stderr = new Capture();
  return {
    context: {
      home: await mkdtemp(path.join(os.tmpdir(), prefix)),
      stdout,
      stderr
    },
    stdout,
    stderr
  };
}

test("e2e dogfood: local CLI agent, no-install curl agent, browser human, brief updates, and close", async () => {
  const host = await makeContext("agentgather-e2e-host-");
  const reviewer = await makeContext("agentgather-e2e-reviewer-");
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  await runRoomCommand(
    ["start", "dogfood-room", "--alias", "operator", "--brief", "Coordinate the release check.", "--url", baseUrl, "--json"],
    host.context
  );
  const started = host.stdout.json<{ token: string }>();
  host.stdout.reset();
  await runRoomCommand(["invite", "reviewer", "--kind", "agent", "--json"], host.context);
  const reviewerInvite = host.stdout.json<{ token: string }>();
  host.stdout.reset();
  await runRoomCommand(["invite", "curl-agent", "--kind", "agent", "--json"], host.context);
  const curlInvite = host.stdout.json<{ token: string }>();
  host.stdout.reset();

  const server = createRoomHttpServer({
    root: host.context.home,
    roomId: "dogfood-room",
    baseUrl,
    // #142: the held-wait/close step below races a long-poll against POST /close.
    // The other waits in this dogfood return immediately on messages, so only the
    // held wait is timeout-bound. A 40ms hold could expire before close commits
    // under CI load (heartbeating back room_status "open"); 1000ms gives ample
    // margin while the held wait still wakes event-driven the moment close lands.
    waitHoldMs: 1_000,
    rateLimitPerMinute: 1_000
  });
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  const browser = await chromium.launch();
  try {
    await runRoomCommand(
      ["join", "dogfood-room", "--alias", "reviewer", "--token", reviewerInvite.token, "--url", baseUrl],
      reviewer.context
    );

    await runSendCommand(["reviewer", "please", "inspect", "the", "handoff", "--json"], host.context);
    const sentToReviewer = host.stdout.json<{ message: { id: number } }>();
    reviewer.stdout.reset();
    await runWatchCommand(["--since", String(sentToReviewer.message.id - 1), "--json"], reviewer.context);
    const watched = reviewer.stdout.json<{ messages: Array<{ text: string }>; keep_waiting: boolean }>();
    assert.equal(watched.messages[0]?.text, "@reviewer please inspect the handoff");
    assert.equal(watched.keep_waiting, false);

    reviewer.stdout.reset();
    await runReplyCommand([String(sentToReviewer.message.id), "@operator reviewed", "--json"], reviewer.context);
    assert.equal(reviewer.stdout.json<{ message: { type: string; text: string } }>().message.type, "reply");
    host.stdout.reset();
    await runReadCommand(["--since", String(sentToReviewer.message.id), "--json"], host.context);
    assert.equal(host.stdout.json<{ messages: Array<{ text: string }> }>().messages.some((message) => message.text === "@operator reviewed"), true);

    const card = await fetch(`${baseUrl}/card?participant=curl-agent&token=${curlInvite.token}`);
    const cardText = await card.text();
    assert.equal(card.status, 200);
    assert.match(cardText, /Coordinate the release check\./);
    const brief = await fetch(`${baseUrl}/brief`, {
      headers: { Authorization: `Bearer ${curlInvite.token}` }
    });
    assert.equal((await brief.json()).brief.brief_version, 1);

    host.stdout.reset();
    await runSendCommand(["curl-agent", "check", "curl", "path", "--json"], host.context);
    const curlWait = await fetch(`${baseUrl}/wait?participant=curl-agent&since_id=0`, {
      headers: { Authorization: `Bearer ${curlInvite.token}` }
    });
    assert.equal((await curlWait.json()).messages.some((message: { text: string }) => message.text.includes("@curl-agent check curl path")), true);
    const curlReply = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${curlInvite.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text: "@operator curl path works" })
    });
    assert.equal(curlReply.status, 201);

    const updatedBrief = await fetch(`${baseUrl}/brief`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${started.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ body: "Final release check." })
    });
    assert.equal((await updatedBrief.json()).brief.brief_version, 2);
    host.stdout.reset();
    await runMessagesCommand(["--since", "0", "--json"], host.context);
    assert.equal(host.stdout.json<{ messages: Array<{ text: string }> }>().messages.some((message) => message.text === "Room brief updated to v2"), true);

    const page = await browser.newPage({ viewport: { width: 980, height: 720 } });
    await page.goto(`${baseUrl}/#token=${started.token}`);
    await page.waitForSelector("text=Choose your room name");
    await page.fill("#display-name", "Operator");
    await page.click("#join-button");
    await page.waitForSelector("text=Final release check.");
    await page.fill("#message-text", "@reviewer browser human here");
    await page.click("#send-button");
    await page.waitForSelector("text=@reviewer browser human here");

    const heldWait = fetch(`${baseUrl}/wait?participant=reviewer&since_id=999`, {
      headers: { Authorization: `Bearer ${reviewerInvite.token}` }
    });
    setTimeout(() => {
      void fetch(`${baseUrl}/close`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${started.token}`,
          "Content-Type": "application/json"
        }
      });
    }, 5);
    const closed = await heldWait;
    const closedBody = await closed.json();
    assert.equal(closedBody.room_status, "closed");
    assert.equal(closedBody.keep_waiting, false);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("dogfood fixture is sanitized", async () => {
  const fixture = await readFile(path.join(process.cwd(), "docs", "dogfood", "sanitized-room-log.jsonl"), "utf8");
  assert.doesNotMatch(fixture, /tgl_[A-Za-z0-9_-]+/);
  assert.doesNotMatch(fixture, /\/Users\/cho/);
  assert.match(fixture, /"room":"dogfood-room"/);
});

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}
