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

test("forum UI: feed → thread → back, rail nesting, markdown body, wake badge, date divider, comment compose, overflow-0 desktop+mobile", { timeout: 120_000 }, async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${fixture.baseUrl}/forum.html?channel=design-forum#token=${fixture.hostToken}`);

    // STATE A (feed): flat post rows with a status pill (no card-in-card)
    await page.waitForSelector(".forum-shell[data-view='feed']");
    await page.waitForSelector(".row .ti:has-text('Forum post layout — single column vs split')");
    assert.equal(await page.locator(".row .st.open").count() >= 1, true);

    // the rail nests the forum's posts under the active forum channel, which
    // stays highlighted while no post is selected (feed state)
    await page.waitForSelector(".channel-link.on:has-text('design-forum')");
    await page.waitForSelector("#rail-subgroup .rail-post");
    assert.match(
      await page.locator("#rail-subgroup").innerText(),
      /Forum post layout — single column vs split/
    );

    // open the post → THREAD state (state B): breadcrumb + safe Markdown body
    await page.click(".row");
    await page.waitForSelector(".forum-shell[data-view='thread']");
    await page.waitForSelector("#detail-title");
    assert.match(await page.locator(".crumb .pt").innerText(), /single column vs split/);
    await page.waitForSelector("#detail-body .code-block");
    assert.match(await page.locator("#detail-body").innerText(), /two-pane split/);
    assert.equal(await page.locator("#detail-body script").count(), 0); // no injection surface

    // selecting a post moves the rail highlight down to the post; the parent
    // forum channel is de-emphasized
    await page.waitForSelector(".rail-post.on");
    await page.waitForSelector(".channel-link.parent:has-text('design-forum')");

    // comments are grouped under a date divider
    await page.waitForSelector(".comments .datediv");
    assert.match(await page.locator(".comments .datediv").first().innerText(), /\d{1,2} \w+ \d{4}/);

    // the agent comment shows the metadata-only wake-on-event badge
    await page.waitForSelector(".cmt .wakebadge");

    // compose a comment → it appends in the thread
    await page.fill("#comment-text", "Shipping the split.");
    await page.click("#comment-form .send");
    await page.waitForSelector("text=Shipping the split.");

    // back-to-list returns to the feed (state A)
    await page.click("#forum-back");
    await page.waitForSelector(".forum-shell[data-view='feed']");
    await page.waitForSelector(".channel-link.on:has-text('design-forum')");

    // overflow-0 at desktop
    const deskOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.equal(deskOverflow, true, "no horizontal overflow at 1280");
    await page.screenshot({ path: path.join(os.tmpdir(), "forum-desktop.png"), fullPage: true });

    // overflow-0 at mobile (rail collapses to a strip; thread fills the pane)
    await page.click(".row");
    await page.waitForSelector(".forum-shell[data-view='thread']");
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

test("forum UI: selected post is URL-addressable — deep link + refresh reopen the thread, invalid id falls back to the feed, no token in the URL", { timeout: 120_000 }, async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

    // Deep link straight to a populated post: the thread opens without a click.
    await page.goto(`${fixture.baseUrl}/forum.html?channel=design-forum&post=rfc-1#token=${fixture.hostToken}`);
    await page.waitForSelector(".forum-shell[data-view='thread']");
    assert.match(await page.locator("#detail-title").innerText(), /single column vs split/);

    // The address bar keeps channel + post but never the bearer token.
    const deepUrl = new URL(page.url());
    assert.equal(deepUrl.searchParams.get("channel"), "design-forum");
    assert.equal(deepUrl.searchParams.get("post"), "rfc-1");
    assert.equal(page.url().includes("token"), false, "token must not be persisted in the URL");

    // Refresh that URL: it reopens the same thread instead of the feed.
    await page.reload();
    await page.waitForSelector(".forum-shell[data-view='thread']");
    assert.match(await page.locator("#detail-title").innerText(), /single column vs split/);

    // Clicking back to the feed drops the post param from the URL.
    await page.click("#forum-back");
    await page.waitForSelector(".forum-shell[data-view='feed']");
    assert.equal(new URL(page.url()).searchParams.get("post"), null);

    // Selecting a post via click syncs the URL so copy-link/refresh work.
    await page.click(".row");
    await page.waitForSelector(".forum-shell[data-view='thread']");
    assert.equal(new URL(page.url()).searchParams.get("post"), "rfc-1");

    // An invalid/missing post id falls back gracefully to the feed and clears it.
    await page.goto(`${fixture.baseUrl}/forum.html?channel=design-forum&post=does-not-exist#token=${fixture.hostToken}`);
    await page.waitForSelector(".row .ti:has-text('Forum post layout — single column vs split')");
    await page.waitForSelector(".forum-shell[data-view='feed']");
    assert.equal(new URL(page.url()).searchParams.get("post"), null);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("forum UI shows an empty state for a forum with no posts", { timeout: 120_000 }, async () => {
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
