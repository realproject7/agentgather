import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createBoardroom, createForumPost, createRoom, writeParticipants } from "../src/storage/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
import type { Participant } from "../src/protocol/index.js";

// Real port so the page origin matches the server baseUrl origin.
function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const mkP = (alias: string, kind: Participant["kind"], token: string, host = false): Participant => ({
  alias,
  kind,
  location: "local",
  install: "lite",
  attention: "manual",
  is_host: host,
  token_hash: participantTokenHash(token),
  joinedAt: "2026-06-21T00:00:00.000Z",
  lastSeenAt: "2026-06-21T00:00:00.000Z"
});

// A multi-channel boardroom: #general (chat) + #review-forum (forum).
async function startBoardroom(): Promise<{ baseUrl: string; hostToken: string; close: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-boardshell-"));
  const hostToken = "tgl_host";
  await createRoom({ root, roomId: "demo", hostAlias: "host" });
  await writeParticipants(root, "demo", [{ ...mkP("host", "human", hostToken, true), display_name: "Host" }]);
  await createBoardroom(root, "demo", {
    name: "ag-project",
    channels: [
      { id: "general", name: "general", type: "chat", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" },
      { id: "review-forum", name: "review-forum", type: "forum", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" }
    ]
  });
  await createForumPost(root, "demo", "review-forum", {
    id: "rfc-1",
    author: "host",
    title: "Route forum reviews here",
    body: "## Proposal\nUse the forum surface.",
    status: "open",
    tags: ["v2"]
  });
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createRoomHttpServer({ root, roomId: "demo", baseUrl, rateLimitPerMinute: 1000 });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { baseUrl, hostToken, close: () => new Promise((r) => server.close(() => r())) };
}

test("boardroom shell: rail from /boardroom routes #general → chat, #review-forum → forum, overflow-0 desktop+mobile", async () => {
  const fixture = await startBoardroom();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // rail renders the two channels (types from /boardroom metadata) and marks
    // the chat channel active on the room (chat) surface.
    await page.waitForSelector("#channel-rail:not([hidden]) .channel-link");
    assert.equal(await page.locator("#channel-rail .channel-link").count(), 2);
    await page.waitForSelector(".channel-link.on:has-text('general')");
    assert.match(await page.locator("#channel-rail").innerText(), /chat/);
    assert.match(await page.locator("#channel-rail").innerText(), /forum/);

    // the rail carries no token text (metadata-only); token rides the href only.
    assert.equal((await page.locator("#channel-rail").innerText()).includes(fixture.hostToken), false);

    // overflow-0 at desktop with the rail present
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      "no horizontal overflow at 1280"
    );
    await page.screenshot({ path: path.join(os.tmpdir(), "boardroom-shell-desktop.png"), fullPage: true });

    // selecting the forum channel routes to the EXISTING forum surface
    await page.click(".channel-link:has-text('review-forum')");
    await page.waitForSelector(".forum-shell");
    await page.waitForSelector("text=Route forum reviews here");
    // the forum surface also shows the rail, now with the forum channel active
    await page.waitForSelector(".channel-link.on:has-text('review-forum')");

    // overflow-0 at mobile on the forum route (rail collapses to a strip)
    await page.setViewportSize({ width: 390, height: 760 });
    await page.waitForTimeout(150);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      "no horizontal overflow at 390"
    );
    await page.screenshot({ path: path.join(os.tmpdir(), "boardroom-shell-mobile.png"), fullPage: true });

    // routing back to the chat channel returns to the room surface
    await page.click(".channel-link:has-text('general')");
    await page.waitForSelector(".room-shell");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("legacy single-channel room renders as today — no channel rail", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-boardshell-legacy-"));
  const hostToken = "tgl_host";
  await createRoom({ root, roomId: "demo", hostAlias: "host", briefBody: "Legacy room." });
  await writeParticipants(root, "demo", [{ ...mkP("host", "human", hostToken, true), display_name: "Host" }]);
  // No createBoardroom → legacy bare room → single #general projection.
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createRoomHttpServer({ root, roomId: "demo", baseUrl, rateLimitPerMinute: 1000 });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${baseUrl}/#token=${hostToken}`);
    await page.waitForSelector(".room-shell");
    // the chat surface loads; the rail stays hidden (single channel = render as today)
    await page.waitForSelector("#room-title");
    assert.equal(await page.locator("#channel-rail:not([hidden])").count(), 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      "no horizontal overflow at 1280"
    );
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
