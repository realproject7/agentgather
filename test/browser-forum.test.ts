import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

// Allocate a real port so the server's baseUrl origin matches the page origin
// (browser POSTs send an Origin header that must pass the same-origin check).
function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}
import {
  addForumComment,
  createBoardroom,
  createForumPost,
  createRoom,
  writeParticipants
} from "../src/storage/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
import type { Participant } from "../src/protocol/index.js";

const mkP = (alias: string, kind: Participant["kind"], token: string, extra: Partial<Participant> = {}): Participant => ({
  alias,
  kind,
  location: "local",
  install: "lite",
  attention: "manual",
  is_host: false,
  token_hash: participantTokenHash(token),
  joinedAt: "2026-06-21T00:00:00.000Z",
  lastSeenAt: "2026-06-21T00:00:00.000Z",
  ...extra
});

async function startFixture(): Promise<{ baseUrl: string; hostToken: string; close: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-forumui-"));
  const hostToken = "tgl_host";
  await createRoom({ root, roomId: "demo", hostAlias: "host" });
  await writeParticipants(root, "demo", [
    { ...mkP("host", "human", hostToken, { display_name: "Host" }), is_host: true },
    // reviewer attends via wake_on_event so the metadata-only badge renders
    mkP("reviewer", "agent", "tgl_rev", { supported_modes: ["wake_on_event"], requested_mode: "wake_on_event", effective_mode: "wake_on_event" })
  ]);
  await createBoardroom(root, "demo", {
    channels: [
      { id: "general", name: "general", type: "chat", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" },
      { id: "design-forum", name: "design-forum", type: "forum", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" }
    ]
  });
  await createForumPost(root, "demo", "design-forum", {
    id: "rfc-1",
    author: "host",
    title: "Forum post layout — single column vs split",
    body: "## Proposal\nUse a **two-pane split**.\n\n```ts\nconst kit = true;\n```",
    status: "open",
    tags: ["ux", "forum"]
  });
  await addForumComment(root, "demo", "design-forum", "rfc-1", { author: "reviewer", body: "Confirmed — reuses the safe renderer." });
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createRoomHttpServer({ root, roomId: "demo", baseUrl, rateLimitPerMinute: 1000 });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { baseUrl, hostToken, close: () => new Promise((r) => server.close(() => r())) };
}

test("forum UI: list → detail, markdown body, agent wake badge, comment compose, overflow-0 desktop+mobile", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${fixture.baseUrl}/forum.html?channel=design-forum#token=${fixture.hostToken}`);

    // post list renders the seeded post + status pill
    await page.waitForSelector("text=Forum post layout — single column vs split");
    assert.equal(await page.locator(".post .st.open").count() >= 1, true);

    // open the post → detail renders with the safe Markdown body (code block)
    await page.click(".post");
    await page.waitForSelector("#detail-title");
    await page.waitForSelector("#detail-body .code-block");
    assert.match(await page.locator("#detail-body").innerText(), /two-pane split/);
    assert.equal(await page.locator("#detail-body script").count(), 0); // no injection surface

    // the agent comment shows the metadata-only wake-on-event badge
    await page.waitForSelector(".cmt .wakebadge");

    // compose a comment → it appends
    await page.fill("#comment-text", "Shipping the split.");
    await page.click("#comment-form .sendbtn");
    await page.waitForSelector("text=Shipping the split.");

    // overflow-0 at desktop
    const deskOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.equal(deskOverflow, true, "no horizontal overflow at 1280");
    await page.screenshot({ path: path.join(os.tmpdir(), "forum-desktop.png"), fullPage: true });

    // overflow-0 at mobile (list → detail)
    await page.setViewportSize({ width: 390, height: 760 });
    await page.waitForTimeout(150);
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.equal(mobileOverflow, true, "no horizontal overflow at 390");
    await page.screenshot({ path: path.join(os.tmpdir(), "forum-mobile.png"), fullPage: true });
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("forum UI shows an empty state for a forum with no posts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-forumempty-"));
  const hostToken = "tgl_host";
  await createRoom({ root, roomId: "demo", hostAlias: "host" });
  await writeParticipants(root, "demo", [{ ...mkP("host", "human", hostToken), is_host: true }]);
  await createBoardroom(root, "demo", {
    channels: [{ id: "design-forum", name: "design-forum", type: "forum", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" }]
  });
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createRoomHttpServer({ root, roomId: "demo", baseUrl, rateLimitPerMinute: 1000 });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${baseUrl}/forum.html?channel=design-forum#token=${hostToken}`);
    await page.waitForSelector("text=No posts yet");
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
