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
import { closeServer } from "./support/close-server.js";
import { captureBrowserFailure, recordBrowserDiagnostics } from "./support/browser-diagnostics.js";

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

async function startFixture(
  options: { postBody?: string; commentBody?: string } = {}
): Promise<{ baseUrl: string; hostToken: string; close: () => Promise<void> }> {
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
    body: options.postBody ?? "## Proposal\nUse a **two-pane split**.\n\n```ts\nconst kit = true;\n```",
    status: "open",
    tags: ["ux", "forum"]
  });
  await addForumComment(root, "demo", "design-forum", "rfc-1", {
    author: "reviewer",
    body: options.commentBody ?? "Confirmed — reuses the safe renderer."
  });
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createRoomHttpServer({ root, roomId: "demo", baseUrl, rateLimitPerMinute: 1000 });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { baseUrl, hostToken, close: () => closeServer(server) };
}

test("forum UI: feed → thread → back, rail nesting, markdown body, wake badge, date divider, comment compose, overflow-0 desktop+mobile", { timeout: 120_000 }, async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  let diagnostics: ReturnType<typeof recordBrowserDiagnostics> | null = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    // #303: failure-only capture; coverage defined by the wait surface.
    diagnostics = recordBrowserDiagnostics(page, page.context());
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
  } catch (error) {
    await captureBrowserFailure(diagnostics, "forum-ui-feed-thread-back-rail-nesting-markdown", error);
    throw error;
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("forum UI: selected post is URL-addressable — deep link + refresh reopen the thread, invalid id falls back to the feed, no token in the URL", { timeout: 120_000 }, async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  let diagnostics: ReturnType<typeof recordBrowserDiagnostics> | null = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    // #303: failure-only capture; coverage defined by the wait surface.
    diagnostics = recordBrowserDiagnostics(page, page.context());

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
  } catch (error) {
    await captureBrowserFailure(diagnostics, "forum-ui-selected-post-is-url-addressable-deep-l", error);
    throw error;
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
  let diagnostics: ReturnType<typeof recordBrowserDiagnostics> | null = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    // #303: failure-only capture; coverage defined by the wait surface.
    diagnostics = recordBrowserDiagnostics(page, page.context());
    await page.goto(`${baseUrl}/forum.html?channel=design-forum#token=${hostToken}`);
    await page.waitForSelector("text=No posts yet");
  } catch (error) {
    await captureBrowserFailure(diagnostics, "forum-ui-shows-an-empty-state-for-a-forum-with-n", error);
    throw error;
  } finally {
    await browser.close();
    await closeServer(server);
  }
});

// #211 — when the host is unreachable, the forum is read-only: mutation controls
// are disabled with an honest notice (no fake offline posts/comments).
test("forum disables new-post/comment when the host is offline (#211)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  let diagnostics: ReturnType<typeof recordBrowserDiagnostics> | null = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    // #303: failure-only capture; coverage defined by the wait surface.
    diagnostics = recordBrowserDiagnostics(page, page.context());
    // The forum assets load from the host, but the posts endpoint is unreachable.
    await page.route(/\/forum\/posts(\?|$)/, (route) =>
      route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "host_unavailable", message: "host offline" })
      })
    );
    await page.goto(`${fixture.baseUrl}/forum.html?channel=design-forum#token=${fixture.hostToken}`);
    await page.waitForSelector("#forum-offline:not([hidden])");
    assert.match((await page.locator("#forum-offline").textContent()) ?? "", /read-only|can't be sent/i);
    await page.waitForFunction(() => (document.getElementById("new-post") as HTMLButtonElement).disabled === true);
    assert.equal(await page.locator("#comment-text").isDisabled(), true);
  } catch (error) {
    await captureBrowserFailure(diagnostics, "forum-disables-new-post-comment-when-the-host-is", error);
    throw error;
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// #250: the forum body and comment views reuse the shared renderer, so the
// ordered-list ordinal fix must hold on both paths — a loose 1/2/3 stays one
// list, and a non-1 start survives in a comment.
test("forum body and comments keep authored ordered-list numbering across blank lines (#250)", { timeout: 120_000 }, async () => {
  const fixture = await startFixture({
    postBody: "## Steps\n1. draft\n\n2. review\n\n3. ship",
    commentBody: "4. verify\n\n6. merge"
  });
  const browser = await chromium.launch();
  let diagnostics: ReturnType<typeof recordBrowserDiagnostics> | null = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    // #303: failure-only capture; coverage defined by the wait surface.
    diagnostics = recordBrowserDiagnostics(page, page.context());
    await page.goto(`${fixture.baseUrl}/forum.html?channel=design-forum#token=${fixture.hostToken}`);
    await page.waitForSelector(".forum-shell[data-view='feed']");
    await page.click(".row");
    await page.waitForSelector(".forum-shell[data-view='thread']");
    await page.waitForSelector("#detail-body ol");
    await page.waitForSelector(".cmt .md ol");

    const rendered = await page.evaluate(() => {
      const read = (selector: string) =>
        Array.from(document.querySelectorAll(selector)).map((ol) => ({
          start: (ol as HTMLOListElement).start,
          items: Array.from(ol.children).map((li) => ({
            text: li.textContent || "",
            value: li.getAttribute("value")
          }))
        }));
      return { body: read("#detail-body ol"), comment: read(".cmt .md ol") };
    });

    // Post body: blank-line-separated 1/2/3 is ONE list starting at 1.
    assert.equal(rendered.body.length, 1, "the post body renders one ordered list");
    assert.equal(rendered.body[0]?.start, 1);
    assert.deepEqual(rendered.body[0]?.items.map((item) => item.text), ["draft", "review", "ship"]);
    assert.deepEqual(rendered.body[0]?.items.map((item) => item.value), [null, null, null]);

    // Comment: a non-1 start survives, and the authored 4 → 6 jump is kept.
    assert.equal(rendered.comment.length, 1, "the comment renders one ordered list");
    assert.equal(rendered.comment[0]?.start, 4);
    assert.deepEqual(rendered.comment[0]?.items.map((item) => item.text), ["verify", "merge"]);
    assert.deepEqual(rendered.comment[0]?.items.map((item) => item.value), [null, "6"]);

    // The renderer stays DOM-only on both forum paths.
    assert.equal(await page.locator("#detail-body script").count(), 0);
    assert.equal(await page.locator(".cmt .md script").count(), 0);
  } catch (error) {
    await captureBrowserFailure(diagnostics, "forum-body-and-comments-keep-authored-ordered-li", error);
    throw error;
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// #247 — the forum surface is the other half of the offline snapshot: when the
// dashboard opened this session, the material the participant has ALREADY loaded
// (the feed, then the thread it opened) is handed to the dashboard so an
// unreachable room stays readable. Nothing is fetched in order to back it up.
test("forum bridges its loaded feed and opened thread to the dashboard snapshot (#247)", { timeout: 120_000 }, async () => {
  const fixture = await startFixture();
  // A dashboard on this device that tracks the same room, so the bridge has a
  // real receiver and a real capability to present.
  const dashRoot = await mkdtemp(path.join(os.tmpdir(), "agentgather-forum-snapshot-"));
  const { createPlatformHttpServer } = await import("../src/platform/index.js");
  const { recordJoinedRoom } = await import("../src/storage/index.js");
  const { writeToken } = await import("../src/cli/state.js");
  const now = new Date().toISOString();
  await recordJoinedRoom(dashRoot, {
    roomId: "demo",
    title: "Demo Room",
    alias: "host",
    baseUrl: fixture.baseUrl,
    joinedAt: now,
    lastSeen: now
  });
  await writeToken(dashRoot, "demo", "host", fixture.hostToken);
  const dashPort = await getFreePort();
  const dashboard = createPlatformHttpServer({ root: dashRoot, ownerUserId: "owner-1" });
  await new Promise<void>((r) => dashboard.listen(dashPort, "127.0.0.1", r));
  const dashboardUrl = `http://127.0.0.1:${dashPort}`;

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let diagnostics: ReturnType<typeof recordBrowserDiagnostics> | null = null;
  try {
    // The capability exists only because the dashboard opened this room.
    const openUrl = new URL(`${dashboardUrl}/joined-rooms/open`);
    openUrl.searchParams.set("room_id", "demo");
    openUrl.searchParams.set("base_url", fixture.baseUrl);
    const redirect = await fetch(openUrl, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    const location = redirect.headers.get("location") ?? "";
    const capability = new URLSearchParams(location.slice(location.indexOf("#") + 1)).get("snapshot");
    assert.equal(typeof capability, "string");

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // #303: failure-only capture; coverage is the 30s wait surface.
    diagnostics = recordBrowserDiagnostics(page, page.context());
    await page.goto(
      `${fixture.baseUrl}/forum.html?channel=design-forum&dashboard=${encodeURIComponent(dashboardUrl)}` +
        `#token=${fixture.hostToken}&snapshot=${encodeURIComponent(capability as string)}`
    );
    // The feed loaded — that alone is bridgeable material.
    await page.waitForSelector("text=Forum post layout — single column vs split");
    // The capability is stripped from the address bar with the token.
    assert.equal(page.url().includes("snapshot="), false);
    assert.equal(page.url().includes("token="), false);

    const readSnapshot = async (): Promise<{ forumPosts: Array<{ id: string; title: string; comments: unknown[] }> } | null> => {
      const url = new URL(`${dashboardUrl}/joined-rooms/history`);
      url.searchParams.set("room_id", "demo");
      url.searchParams.set("base_url", fixture.baseUrl);
      return ((await (await fetch(url)).json()) as { snapshot: { forumPosts: Array<{ id: string; title: string; comments: unknown[] }> } | null }).snapshot;
    };
    let snapshot = await readSnapshot();
    for (let attempt = 0; attempt < 100 && (snapshot?.forumPosts.length ?? 0) === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      snapshot = await readSnapshot();
    }
    assert.equal(snapshot?.forumPosts[0]?.id, "rfc-1");
    assert.match(snapshot?.forumPosts[0]?.title ?? "", /single column vs split/);
    // The feed row carries no comments — they were never loaded yet.
    assert.equal(snapshot?.forumPosts[0]?.comments.length, 0);

    // Opening the thread loads its comments; only then are they snapshotted.
    await page.click("text=Forum post layout — single column vs split");
    await page.waitForSelector("text=Confirmed — reuses the safe renderer.");
    for (let attempt = 0; attempt < 100 && (snapshot?.forumPosts[0]?.comments.length ?? 0) === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      snapshot = await readSnapshot();
    }
    assert.equal(snapshot?.forumPosts[0]?.comments.length, 1);
    // Still exactly one post — a re-load merges rather than duplicating.
    assert.equal(snapshot?.forumPosts.length, 1);
    // And the saved copy carries nothing credential-shaped.
    assert.equal(/tgl_|Bearer|token=|snapshot=/i.test(JSON.stringify(snapshot)), false);
  } catch (error) {
    await captureBrowserFailure(diagnostics, "forum-bridges-its-loaded-feed-and-opened-thread", error);
    throw error;
  } finally {
    await browser?.close();
    await closeServer(dashboard);
    await fixture.close();
  }
});
