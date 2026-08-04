import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { chromium } from "playwright";
import type { CliContext } from "../../src/cli/context.js";
import { runRoomCommand } from "../../src/cli/commands/room/index.js";
import { runTunnelCommand } from "../../src/cli/commands/tunnel/index.js";
import { createRoomHttpServer } from "../../src/server/index.js";
import { createBrokerHttpServer, readPublicBaseUrl, TunnelBroker } from "../../src/tunnel/index.js";
import { closeServer } from "../support/close-server.js";

class Capture extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    callback();
  }
  json<T>(): T {
    return JSON.parse(this.chunks.join("")) as T;
  }
  reset(): void {
    this.chunks = [];
  }
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("e2e tunnel: browser human and curl agent reach the room through the broker", async () => {
  const stdout = new Capture();
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "agentgather-tunnel-e2e-")),
    stdout,
    stderr: new Capture()
  };
  const hostPort = await getFreePort();
  const hostBaseUrl = `http://127.0.0.1:${hostPort}`;

  await runRoomCommand(
    ["start", "tunnel-room", "--alias", "operator", "--brief", "Forward through the broker.", "--url", hostBaseUrl, "--show-token", "--json"],
    context
  );
  const hostToken = stdout.json<{ token: string }>().token;
  stdout.reset();
  await runRoomCommand(["invite", "human", "--kind", "human", "--show-token", "--json"], context);
  const humanToken = stdout.json<{ token: string }>().token;
  stdout.reset();
  await runRoomCommand(["invite", "curl-agent", "--kind", "agent", "--show-token", "--json"], context);
  const curlToken = stdout.json<{ token: string }>().token;

  const broker = new TunnelBroker({ routeTtlMs: 60_000 });
  const brokerServer = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => brokerServer.listen(0, "127.0.0.1", resolve));
  const brokerBaseUrl = `http://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`;

  const hostServer = createRoomHttpServer({
    root: context.home,
    roomId: "tunnel-room",
    baseUrl: hostBaseUrl,
    waitHoldMs: 60,
    rateLimitPerMinute: 1_000,
    publicBaseUrl: () => readPublicBaseUrl(context.home, "tunnel-room") ?? hostBaseUrl
  });
  await new Promise<void>((resolve) => hostServer.listen(hostPort, "127.0.0.1", resolve));

  stdout.reset();
  await runTunnelCommand(
    ["start", "--broker", brokerBaseUrl, "--subdomain", "tunnel-room", "--target", hostBaseUrl, "--json"],
    context
  );
  const publicBaseUrl = stdout.json<{ public_base_url: string }>().public_base_url;
  assert.equal(publicBaseUrl, `${brokerBaseUrl}/tunnel-room`);

  const browser = await chromium.launch();
  try {
    // Invite card generated after tunnel start uses the broker URL.
    stdout.reset();
    await runRoomCommand(["invite-card", "curl-agent"], context);
    // #109: the broker URL is rendered once via the AG_BASE export.
    assert.equal(stdout.chunks.join("").includes(`AG_BASE='${publicBaseUrl}'`), true);

    // Curl-style remote agent: fetch card, join, send, read, wait through the broker.
    const card = await fetch(`${publicBaseUrl}/card?participant=curl-agent&token=${curlToken}`);
    const cardText = await card.text();
    assert.equal(card.status, 200);
    assert.match(cardText, /Forward through the broker\./);
    assert.equal(cardText.includes(`AG_BASE='${publicBaseUrl}'`), true);
    assert.equal(cardText.includes("$AG_BASE/messages"), true);

    const joined = await fetch(`${publicBaseUrl}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${curlToken}` }
    });
    assert.equal(joined.status, 200);

    const sent = await fetch(`${publicBaseUrl}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${curlToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "@operator curl agent through broker" })
    });
    assert.equal(sent.status, 201);

    // Browser human joins and sends through the broker, loading shell + assets.
    const page = await browser.newPage({ viewport: { width: 980, height: 720 } });
    await page.goto(`${publicBaseUrl}/#token=${humanToken}`);
    await page.waitForSelector("text=Choose your display name");
    await page.fill("#display-name", "Remote Human");
    await page.click("#join-button");
    await page.waitForSelector("text=Forward through the broker.");
    // #264: the brief rendering does NOT mean entry has finished. `enterRoom`
    // paints the brief, then still awaits the first `/messages` poll — another
    // full relay round-trip through the broker — before `bindEvents()` attaches
    // the composer's submit handler. `#send-button` is a `type="submit"` inside
    // `<form id="composer">`, so a click landing in that window performs a NATIVE
    // form submission: the page navigates, the composer clears, and no message is
    // ever posted. On a quiet machine the window is sub-millisecond; under
    // full-suite load each round-trip stretches and the click lands inside it.
    // Wait for what that first poll must render — the curl agent's message, posted
    // above and already in the host log — which entry produces immediately before
    // binding the composer.
    await page.waitForSelector("text=@operator curl agent through broker");
    await page.fill("#message-text", "@operator browser through broker");
    await page.click("#send-button");
    await page.waitForSelector("text=@operator browser through broker");

    // A held /wait releases on room close through the broker.
    const held = fetch(`${publicBaseUrl}/wait?participant=curl-agent&since_id=999`, {
      headers: { Authorization: `Bearer ${curlToken}` }
    });
    // #258: tracked, not dropped — see the same pattern in cli-message/tunnel tests.
    const closeIssued = new Promise<void>((resolve) => {
      setTimeout(() => {
        void fetch(`${publicBaseUrl}/close`, {
          method: "POST",
          headers: { Authorization: `Bearer ${hostToken}`, "Content-Type": "application/json" }
        })
          .catch(() => undefined)
          .finally(() => resolve());
      }, 10);
    });
    const closed = (await (await held).json()) as { room_status: string; keep_waiting: boolean };
    assert.equal(closed.room_status, "closed");
    assert.equal(closed.keep_waiting, false);
    await closeIssued;
  } finally {
    await browser.close();
    await closeServer(brokerServer);
    await closeServer(hostServer);
  }
});
