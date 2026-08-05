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
import { closeServer } from "./support/close-server.js";
import { recordBrowserDiagnostics } from "./support/browser-diagnostics.js";

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
  return { baseUrl, hostToken, close: () => closeServer(server) };
}

// Per-test timeouts so a container-specific hang fails this test fast instead
// of stalling the whole CI job to its 20-minute ceiling.
test("boardroom shell: rail from /boardroom routes #general → chat, #review-forum → forum, overflow-0 desktop+mobile", { timeout: 120_000 }, async () => {
  const fixture = await startBoardroom();
  const browser = await chromium.launch();
  let diagnostics: ReturnType<typeof recordBrowserDiagnostics> | null = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    // #289: records nothing unless this test fails. One of the two CI failures was
    // here — `waitForEvent("page")` consuming its full 30s ceiling while every
    // other step ran at normal speed. The artifact says which branch that was.
    diagnostics = recordBrowserDiagnostics(page, page.context());
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // rail renders the two channels (types from /boardroom metadata) and marks
    // the chat channel active on the room (chat) surface.
    await page.waitForSelector("#channel-rail:not([hidden]) .channel-link");
    assert.equal(await page.locator("#channel-rail .channel-link").count(), 2);
    await page.waitForSelector(".channel-link.on:has-text('general')");
    assert.match(await page.locator("#channel-rail").innerText(), /chat/);
    assert.match(await page.locator("#channel-rail").innerText(), /forum/);

    // #276 — the rail is a persistent nav, so it must say WHICH room it belongs to,
    // not only list channels. Without this a participant reading the sidebar has no
    // indication of the room currently open.
    assert.equal((await page.locator("#channel-rail .rail-head .room").textContent())?.trim(), "ag-project");
    // ...and the channel area reflects that room: its channels, with the open one
    // marked. The active mark is what makes "current" a claim rather than a list.
    assert.equal(await page.locator("#channel-rail .channel-link.on").count(), 1);

    // #276 — the rail must be token-free in its MARKUP, not merely in its visible
    // text. The pre-existing check below reads `innerText`, which excludes
    // attributes, so a credential sitting in an `href` passed it unseen — which is
    // how the rail came to be described as token-free while every channel link
    // carried the session token in its fragment.
    const railHtml = (await page.locator("#channel-rail").innerHTML()) ?? "";
    assert.equal(railHtml.includes(fixture.hostToken), false, "no token anywhere in the rail markup");
    assert.equal(/tgl_|Bearer|token=|invite=|card=/i.test(railHtml), false, "no credential-shaped value in the rail");
    const hrefs = await page.locator("#channel-rail a").evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLAnchorElement).getAttribute("href") ?? "")
    );
    assert.ok(hrefs.length > 0, "the rail rendered no links to check");
    for (const href of hrefs) {
      assert.equal(/token=|tgl_/i.test(href), false, `channel href carries a credential: ${href}`);
    }
    // ...and the navigation still authenticates without it: the target surface reads
    // this tab's sessionStorage copy, which is why the URL never needed the token.
    assert.equal(
      await page.evaluate(() => window.sessionStorage.getItem("agentgather.token") !== null),
      true,
      "the tab-scoped token the rail relies on is present"
    );

    assert.equal((await page.locator("#channel-rail").innerText()).includes(fixture.hostToken), false);

    // #276 — OBSERVED fresh-tab behaviour, not the expected one (@head).
    //
    // Modifier-click is deliberately NOT used here: `Meta` is macOS-only and
    // headless Chromium opens no popup for it, so that check timed out in CI while
    // passing locally — a test that only runs on one machine proves nothing. This
    // opens the same URL in a genuinely fresh tab, which is what a participant does
    // by pasting a copied link and is the case that must hold everywhere.
    const channelHref = await page.locator("#channel-rail a").first().getAttribute("href");
    assert.ok(channelHref, "no channel link to open");
    const freshUrl = new URL(channelHref, page.url()).toString();
    assert.equal(/token=|tgl_/i.test(freshUrl), false, "a copied channel URL must carry no credential");

    // A separate context, which shares no storage at all. That is strictly stronger
    // than a new tab in the same profile: if the URL lands coherently with nothing
    // inherited, it lands coherently in the weaker case too.
    const freshContext = await browser.newContext();
    const fresh = await freshContext.newPage();
    await fresh.goto(freshUrl);
    await fresh.waitForSelector("#room-title, .forum-shell, #auth-error", { timeout: 15000 });
    const observed = await fresh.evaluate(() => ({
      token: window.sessionStorage.getItem("agentgather.token"),
      body: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 120)
    }));
    console.log(`[#276 OBSERVED fresh tab] sessionToken=${observed.token === null ? "ABSENT" : "PRESENT"}`);
    console.log(`[#276 OBSERVED fresh tab] body=${JSON.stringify(observed.body)}`);
    // What must hold on every browser: the tab lands in a COHERENT state — either
    // authenticated, or explicitly asking for an invite — never blank or half
    // rendered. Asserting the exact absence would pin a browser-version detail.
    const asksForInvite = await fresh.locator("#auth-error:not([hidden])").isVisible().catch(() => false);
    const authenticated = observed.token !== null;
    assert.equal(
      authenticated || asksForInvite,
      true,
      `fresh tab landed in neither state: token=${observed.token === null ? "absent" : "present"} body=${observed.body}`
    );
    await fresh.close();
    await freshContext.close();

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

    // the forum surface's rail links the chat channel back to the room surface
    assert.match(await page.locator(".channel-link:has-text('general')").getAttribute("href") ?? "", /^\.\/(#token=)?/);
  } catch (error) {
    // Write the artifact, then rethrow untouched: this must never convert a
    // failure into a pass, and the assertion the runner reports stays the
    // original one.
    if (diagnostics !== null) await diagnostics.write("boardroom-shell-rail", error);
    throw error;
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// A boardroom with a non-#general chat channel alongside #general + a forum.
async function startBoardroomWithDisabledChat(): Promise<{ baseUrl: string; hostToken: string; close: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-boardshell-disabled-"));
  const hostToken = "tgl_host";
  await createRoom({ root, roomId: "demo", hostAlias: "host" });
  await writeParticipants(root, "demo", [{ ...mkP("host", "human", hostToken, true), display_name: "Host" }]);
  await createBoardroom(root, "demo", {
    name: "ag-project",
    channels: [
      { id: "general", name: "general", type: "chat", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" },
      { id: "review-forum", name: "review-forum", type: "forum", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" },
      { id: "ops-chat-test", name: "ops-chat-test", type: "chat", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" }
    ]
  });
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createRoomHttpServer({ root, roomId: "demo", baseUrl, rateLimitPerMinute: 1000 });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { baseUrl, hostToken, close: () => closeServer(server) };
}

test("boardroom shell: a non-#general chat channel is disabled and opens a not-active pane (V2 #167), overflow-0 desktop+mobile", { timeout: 120_000 }, async () => {
  const fixture = await startBoardroomWithDisabledChat();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // rail renders all three channels; #general stays the active functional chat
    await page.waitForSelector("#channel-rail:not([hidden]) .channel-link");
    assert.equal(await page.locator("#channel-rail .channel-link").count(), 3);
    await page.waitForSelector(".channel-link.on:has-text('general')");

    // the non-#general chat channel is disabled: dimmed, a "soon" tag, and NOT a
    // navigable link (rendered as a div, not an <a> into the room-wide log)
    const disabled = page.locator(".channel-link.disabled:has-text('ops-chat-test')");
    await disabled.waitFor();
    assert.equal(await disabled.locator(".soon").count(), 1);
    assert.equal(await disabled.evaluate((el) => el.tagName), "DIV");

    // selecting it shows the not-active pane (NOT the chat surface) with a
    // Go to #general action; the reused room surface is hidden
    await disabled.click();
    await page.waitForSelector(".not-active-pane:not([hidden])");
    assert.match(await page.locator(".not-active-pane .na-name").innerText(), /ops-chat-test/);
    assert.match(await page.locator(".not-active-pane").innerText(), /only #general/i);
    await page.waitForSelector(".not-active-pane .na-go:has-text('Go to #general')");
    assert.equal(await page.locator(".room-shell:visible").count(), 0);
    // URL did not route into the chat/global surface
    assert.equal(new URL(page.url()).search, "");

    // the forum channel stays a real link to the forum surface
    assert.match(
      (await page.locator(".channel-link:has-text('review-forum')").getAttribute("href")) ?? "",
      /^forum\.html\?channel=review-forum/
    );

    // overflow-0 at desktop with the not-active pane shown
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      "no horizontal overflow at 1280"
    );

    // overflow-0 at mobile (rail collapses to a strip; pane fills the width)
    await page.setViewportSize({ width: 390, height: 760 });
    await page.waitForTimeout(150);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      "no horizontal overflow at 390"
    );
    await page.screenshot({ path: path.join(os.tmpdir(), "chat-disabled-mobile.png"), fullPage: true });
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("legacy single-channel room renders as today — no channel rail", { timeout: 120_000 }, async () => {
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
    await closeServer(server);
  }
});
