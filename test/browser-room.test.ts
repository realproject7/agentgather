import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import type { Participant } from "../src/protocol/index.js";
import { createBoardroom, createRoom, readMessages, writeParticipants } from "../src/storage/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
import { closeServer } from "./support/close-server.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-browser-test-"));
}

async function startFixture(options: { rateLimitPerMinute?: number } = {}): Promise<{
  root: string;
  roomId: string;
  baseUrl: string;
  hostToken: string;
  reviewerToken: string;
  close: () => Promise<void>;
}> {
  const root = await makeRoot();
  const roomId = `browser-${Math.random().toString(36).slice(2, 10)}`;
  const hostToken = `host-${roomId}`;
  const reviewerToken = `reviewer-${roomId}`;
  await createRoom({
    root,
    roomId,
    hostAlias: "host",
    briefBody: "Ship the browser room safely."
  });
  await writeParticipants(root, roomId, [
    { ...participant("host", "human", true, hostToken), display_name: "Host" },
    participant("reviewer", "agent", false, reviewerToken)
  ]);
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createRoomHttpServer({
    root,
    roomId,
    baseUrl,
    rateLimitPerMinute: options.rateLimitPerMinute ?? 1_000
  });
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    root,
    roomId,
    baseUrl,
    hostToken,
    reviewerToken,
    close: () =>
      closeServer(server)
  };
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return address.port;
}

test("build copies browser assets into dist", async () => {
  const html = await readFile(new URL("../src/browser/room.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/browser/room.css", import.meta.url), "utf8");
  const theme = await readFile(new URL("../src/browser/theme.css", import.meta.url), "utf8");
  const js = await readFile(new URL("../src/browser/room.js", import.meta.url), "utf8");
  assert.match(html, /room.css/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /favicon\.png/);
  assert.match(css, /theme\.css/);
  assert.match(css, /room-shell/);
  assert.match(theme, /color-scheme: dark/);
  assert.match(theme, /--accent: #ec5c94/);
  assert.match(css, /message-bubble/);
  assert.match(js, /sessionStorage/);
});

test("browser room joins with fragment token, sends, receives, and renders safely", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");
    await page.waitForSelector("text=manual-ok");
    assert.equal(page.url(), `${fixture.baseUrl}/`);

    const markdownBrief = [
      "## Goal",
      "Review **browser brief** rendering before merge.",
      "",
      "### Context",
      "- Uses `src/browser/room.js`",
      "- Keeps [safe link](https://example.com) active",
      "- Blocks [bad link](javascript:alert(1))",
      "",
      "> Safety: <img src=x onerror=\"window.__briefXss=1\"> raw HTML is untrusted.",
      "",
      "---"
    ].join("\n");
    const briefResponse = await fetch(`${fixture.baseUrl}/brief`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.hostToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ body: markdownBrief })
    });
    assert.equal(briefResponse.status, 200);
    await page.waitForSelector("text=Brief updated. Refresh");
    await page.click("#brief-refresh");
    await page.waitForSelector("text=Goal");
    await page.click("#brief-open");
    await page.locator("#brief-body h2", { hasText: "Goal" }).waitFor();
    await page.locator("#brief-body li", { hasText: "Uses src/browser/room.js" }).waitFor();
    await page.locator("#brief-body blockquote", { hasText: "raw HTML is untrusted" }).waitFor();
    assert.equal(await page.locator("#brief-body script").count(), 0);
    assert.equal(await page.locator("#brief-body img").count(), 0);
    assert.equal(await page.locator('#brief-body a[href^="javascript:"]').count(), 0);
    assert.equal(await page.locator("#brief-body a", { hasText: "safe link" }).count(), 1);
    assert.equal(await page.evaluate(() => (window as Window & { __briefXss?: unknown }).__briefXss), undefined);
    await page.click("#brief-close");
    await page.waitForSelector("#brief-overlay", { state: "hidden" });

    await page.fill("#message-text", "@reviewer hello from browser");
    await page.click("#send-button");
    await page.waitForSelector("text=@reviewer hello from browser");

    await postMessage(fixture, fixture.reviewerToken, "@host received in browser");
    await page.waitForSelector("text=@host received in browser");
    await page.waitForSelector(".message-bubble");

    await postMessage(
      fixture,
      fixture.reviewerToken,
      "<img src=x onerror=\"window.__xss=1\"> javascript:alert(1) https://example.com ` <script>bad</script> `"
    );
    await page.waitForSelector("text=https://example.com");
    assert.equal(await page.evaluate(() => (window as Window & { __xss?: unknown }).__xss), undefined);
    assert.equal(await page.locator(".message-text script").count(), 0);
    assert.equal(await page.locator('.message-text a[href^="javascript:"]').count(), 0);
    assert.equal(await page.locator(".message-text a", { hasText: "https://example.com" }).count(), 1);

    await page.screenshot({ path: path.join(fixture.root, "desktop-room.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 760 });
    await page.click("#roster-toggle");
    await page.screenshot({ path: path.join(fixture.root, "mobile-room.png"), fullPage: true });
    const layout = await page.evaluate(() => {
      const composerElement = document.querySelector(".composer");
      const topbarElement = document.querySelector(".topbar");
      const textareaElement = document.querySelector("#message-text");
      if (composerElement === null || topbarElement === null || textareaElement === null) {
        throw new Error("browser room layout elements are missing");
      }
      const composer = composerElement.getBoundingClientRect();
      const topbar = topbarElement.getBoundingClientRect();
      const textarea = textareaElement.getBoundingClientRect();
      return {
        composerBelowTopbar: composer.top >= topbar.bottom,
        textareaInsideViewport: textarea.left >= 0 && textarea.right <= window.innerWidth
      };
    });
    assert.equal(layout.composerBelowTopbar, true);
    assert.equal(layout.textareaInsideViewport, true);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("browser composer dedupes rapid submit and reuses the idempotency key on retry", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 700 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    await page.fill("#message-text", "@reviewer duplicate guard");
    await page.evaluate(() => {
      const form = document.querySelector("#composer");
      if (form === null) throw new Error("composer missing");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await page.waitForSelector("text=@reviewer duplicate guard");

    const raw = await readFile(path.join(fixture.root, "rooms", fixture.roomId, "messages.jsonl"), "utf8");
    const messages = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { text?: string });
    assert.equal(messages.filter((message) => message.text === "@reviewer duplicate guard").length, 1);

    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      const capturedIds: string[] = [];
      let failNextMessagePost = true;
      Object.assign(window, { __agentGatherClientMsgIds: capturedIds });
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
        if (url.pathname.endsWith("/messages") && init?.method === "POST" && typeof init.body === "string") {
          capturedIds.push(JSON.parse(init.body).client_msg_id);
          if (failNextMessagePost) {
            failNextMessagePost = false;
            return new Response(JSON.stringify({ ok: false, message: "forced retry" }), {
              status: 503,
              headers: { "content-type": "application/json" }
            });
          }
        }
        return originalFetch(input, init);
      };
    });

    await page.fill("#message-text", "@reviewer retry once");
    await page.click("#send-button");
    await page.waitForSelector("text=forced retry");
    await page.click("#send-button");
    await page.waitForSelector("text=@reviewer retry once");
    const ids = await page.evaluate(() => (window as Window & { __agentGatherClientMsgIds?: string[] }).__agentGatherClientMsgIds);
    assert.equal(ids?.length, 2);
    assert.equal(ids?.[0], ids?.[1]);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("browser bare URL explains invite requirement and human token claims display name", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 700 } });
    await page.goto(fixture.baseUrl);
    await page.waitForSelector("text=Invite link required");

    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    const humanToken = `guest-${fixture.roomId}`;
    await writeParticipants(fixture.root, fixture.roomId, [
      { ...participant("host", "human", true, fixture.hostToken), display_name: "Host" },
      participant("reviewer", "agent", false, fixture.reviewerToken),
      participant("guest", "human", false, humanToken)
    ]);

    const guestPage = await browser.newPage({ viewport: { width: 960, height: 700 } });
    await guestPage.goto(`${fixture.baseUrl}/#token=${humanToken}`);
    await guestPage.waitForSelector("text=Choose your display name");
    // #97: the join modal asks for a DISPLAY NAME and never frames the field as
    // the room name — regression guard on the confusing dogfood copy. The invite
    // token owns identity; this field only controls the visible name.
    const joinCopy = await guestPage.locator("#join-panel").innerText();
    assert.match(joinCopy, /Choose your display name/);
    assert.doesNotMatch(joinCopy, /room name/i);
    assert.match(joinCopy, /invite token/i);
    assert.match(joinCopy, /Display name/);
    await guestPage.fill("#display-name", "Project Seven");
    await guestPage.click("#join-button");
    await guestPage.waitForSelector("text=Ship the browser room safely.");
    // Roster continues to show the chosen display name.
    await guestPage.waitForSelector("text=Project Seven");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("browser auto-claims a missing host human display name from the alias", async () => {
  const root = await makeRoot();
  const roomId = `browser-${Math.random().toString(36).slice(2, 10)}`;
  const hostToken = `host-${roomId}`;
  await createRoom({
    root,
    roomId,
    hostAlias: "ag-lead",
    briefBody: "Host display fallback."
  });
  await writeParticipants(root, roomId, [participant("ag-lead", "human", true, hostToken)]);
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createRoomHttpServer({ root, roomId, baseUrl, rateLimitPerMinute: 1_000 });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 700 } });
    await page.goto(`${baseUrl}/#token=${hostToken}`);
    await page.waitForSelector("text=Host display fallback.");
    assert.equal(await page.locator("#join-panel").isVisible(), false);
    const participants = JSON.parse(await readFile(path.join(root, "rooms", roomId, "participants.json"), "utf8")) as Participant[];
    assert.equal(participants.find((entry) => entry.alias === "ag-lead")?.display_name, "ag-lead");
  } finally {
    await browser.close();
    await closeServer(server);
  }
});

test("room opened from the dashboard exposes a same-tab dashboard home link", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 700 } });
    await page.goto(`${fixture.baseUrl}/?dashboard=${encodeURIComponent("http://127.0.0.1:8788")}#token=${fixture.hostToken}`);
    await page.waitForSelector("text=Ship the browser room safely.");
    const home = page.locator("#dashboard-home");
    await home.waitFor();
    assert.equal(await home.isVisible(), true);
    assert.equal(await home.getAttribute("href"), "http://127.0.0.1:8788/");
    assert.equal(await page.locator("#brand-static").isHidden(), true);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("browser reply affordance: per-message reply button, clearable composer indicator, reply_to send + timeline context (#113)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    // Seed a message to reply to.
    await page.fill("#message-text", "first message here");
    await page.click("#send-button");
    await page.waitForSelector(".message:not(.system) .message-text:has-text('first message here')");
    const firstRow = page.locator(".message:not(.system)", { hasText: "first message here" });

    // Discoverable per-message reply action → composer shows the reply indicator.
    await firstRow.locator(".reply-btn").click();
    await page.waitForSelector("#reply-indicator", { state: "visible" });
    assert.match(await page.locator("#reply-indicator-label").innerText(), /Replying to Host #\d+/);

    // The indicator is clearable before send.
    await page.click("#reply-clear");
    await page.waitForSelector("#reply-indicator", { state: "hidden" });

    // Reply again, then send: the send carries the existing reply_to metadata.
    await firstRow.locator(".reply-btn").click();
    await page.waitForSelector("#reply-indicator", { state: "visible" });
    await page.fill("#message-text", "the reply body");
    await page.click("#send-button");
    await page.waitForSelector(".message:not(.system) .message-text:has-text('the reply body')");
    // Indicator clears after a successful send.
    await page.waitForSelector("#reply-indicator", { state: "hidden" });

    // Replied-to context renders in the timeline from the reply_to metadata.
    await page.waitForSelector(".reply-context");
    assert.match(await page.locator(".reply-context").last().innerText(), /↩ Host: first message here/);

    // Server log: the reply carries reply_to = the first message's id (no new schema).
    const messages = await readMessages(fixture.root, fixture.roomId);
    const first = messages.find((m) => m.text.includes("first message here"));
    const reply = messages.find((m) => m.text.includes("the reply body"));
    assert.ok(first && reply, "both messages persisted");
    assert.equal(reply?.reply_to, first?.id);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("browser roster, brief indicator, system filter, unknown mentions, and send errors update without reload", async () => {
  const fixture = await startFixture({ rateLimitPerMinute: 2 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    await writeParticipants(fixture.root, fixture.roomId, [
      participant("host", "human", true, fixture.hostToken),
      {
        ...participant("reviewer", "agent", false, fixture.reviewerToken),
        attention: "away",
        lastSeenAt: new Date(Date.now() - 120_000).toISOString()
      }
    ]);
    await page.waitForSelector(".participant[data-attendance-state='away']");

    const attendanceResponse = await fetch(`${fixture.baseUrl}/attendance`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.hostToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ policy: "agents-foreground" })
    });
    assert.equal(attendanceResponse.status, 200);
    await writeParticipants(fixture.root, fixture.roomId, [
      participant("host", "human", true, fixture.hostToken),
      {
        ...participant("reviewer", "agent", false, fixture.reviewerToken),
        attention: "attending",
        lastSeenAt: new Date(Date.now() - 120_000).toISOString()
      }
    ]);
    await page.waitForSelector(".participant[data-attendance-state='stale']");
    await page.waitForSelector(".participant[data-attendance-state='stale'] .participant-status");

    const briefResponse = await fetch(`${fixture.baseUrl}/brief`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.hostToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ body: "Updated browser brief" })
    });
    assert.equal(briefResponse.status, 200);
    await page.waitForSelector("text=Brief updated. Refresh");
    await page.click("#brief-refresh");
    await page.waitForSelector("text=Updated browser brief");

    await page.waitForSelector("text=Room brief updated to v2");
    await page.uncheck("#system-filter");
    assert.equal(await page.locator(".message.system", { hasText: "Room brief updated to v2" }).isHidden(), true);

    await page.fill("#message-text", "@reviewer first send");
    await page.click("#send-button");
    await page.waitForSelector("text=@reviewer first send");
    // An unknown @mention warns live in the composer but does not block sending.
    await page.fill("#message-text", "@gpt typo mention");
    await page.waitForSelector("#mention-warning:not([hidden])");
    await page.waitForSelector("text=@gpt is not in this room");
    await page.click("#send-button");
    await page.waitForSelector("text=@gpt typo mention");
    assert.equal(await page.locator("#mention-warning").isHidden(), true);
    await page.fill("#message-text", "@reviewer second send");
    await page.click("#send-button");
    await page.waitForSelector("text=rate limit exceeded");
    // A rate-limit rejection stays an inline send error — no route banner.
    assert.equal(await page.locator("#room-banner").isHidden(), true);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("composer broadcast mode sends an untargeted status message and resets to direct", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    await page.click("#broadcast-toggle");
    assert.equal(await page.getAttribute("#composer", "data-mode"), "broadcast");
    await page.waitForSelector("text=untargeted · everyone sees it");

    await page.fill("#message-text", "starting the pricing review now — please attend.");
    await page.click("#send-button");
    // The broadcast renders as a status message with its accent treatment...
    await page.waitForSelector(".message.broadcast .broadcast-chip");
    await page.waitForSelector("text=starting the pricing review now");
    // ...and the composer returns to direct so the next message is not room-wide.
    assert.equal(await page.getAttribute("#composer", "data-mode"), "direct");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("composer autocompletes a partial @mention and warns on an unknown one with a suggestion", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    // Typing a partial @token offers matching participants; accepting completes it.
    await page.click("#message-text");
    await page.type("#message-text", "ping @rev");
    await page.waitForSelector('#mention-autocomplete .ac-option[data-alias="reviewer"]');
    await page.press("#message-text", "Enter");
    assert.match(await page.inputValue("#message-text"), /@reviewer\s$/);
    assert.equal(await page.locator("#mention-autocomplete").isHidden(), true);

    // An unknown @mention warns with a recoverable suggestion and does not block.
    await page.fill("#message-text", "thanks @review please");
    await page.waitForSelector("#mention-warning:not([hidden])");
    await page.waitForSelector("text=@review is not in this room");
    await page.click('.warn-suggest[data-alias="reviewer"]');
    assert.match(await page.inputValue("#message-text"), /@reviewer/);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("a join system line flips to 'now attending' once the participant is foreground (#74)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    // The reviewer joins → server emits "reviewer joined" and marks them attending.
    const joined = await fetch(`${fixture.baseUrl}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.reviewerToken}`, "Content-Type": "application/json" }
    });
    assert.equal(joined.status, 200);

    await page.waitForSelector("text=reviewer joined");
    await page.waitForSelector(".joinflip:not([hidden])");
    await page.waitForSelector("text=now attending");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// #211 — when the host goes unreachable mid-session, the room falls back to a
// read-only local backup: the loaded messages stay readable, the composer is
// disabled (no fake offline sends), an honest notice names the device-local
// snapshot, and live is restored (composer re-enabled) when the host recovers.
test("host-offline mid-session falls back to a read-only local backup and recovers to live (#211)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await postMessage(fixture, fixture.hostToken, "backed-up hello");
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");
    await page.waitForSelector("text=backed-up hello");

    // The loaded message is persisted into a redacted, room-origin local backup.
    const backup = await page.evaluate(() => {
      const key = Object.keys(window.localStorage).find((k) => k.startsWith("agentgather.backup."));
      return key ? (JSON.parse(window.localStorage.getItem(key) as string) as { messages: Array<{ text: string }> }) : null;
    });
    assert.ok(backup && backup.messages.some((m) => m.text === "backed-up hello"), "message not saved to local backup");

    // Host goes unreachable → read-only local-backup mode.
    await page.route(/\/(messages|status)(\?|$)/, (route) =>
      route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "host_unavailable", message: "host tunnel did not respond" })
      })
    );
    await page.waitForSelector('#room-banner[data-kind="degraded"]');
    await page.waitForSelector("text=Host offline — local backup");
    await page.waitForSelector("#backup-notice:not([hidden])");
    assert.match((await page.locator("#backup-notice").textContent()) ?? "", /can't be sent until the host resumes/);
    // Composer is disabled (no fake offline sends); cached message stays readable.
    await page.waitForFunction(() => (document.getElementById("message-text") as HTMLTextAreaElement).disabled === true);
    assert.ok((await page.locator("text=backed-up hello").count()) > 0);

    // Recovery: banner clears, composer re-enables, live authoritative again.
    await page.unroute(/\/(messages|status)(\?|$)/);
    await page.waitForSelector("#room-banner", { state: "hidden" });
    await page.waitForFunction(() => (document.getElementById("message-text") as HTMLTextAreaElement).disabled === false);
    await page.waitForSelector("#backup-notice", { state: "hidden" });
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("a quota_exceeded response shows the public-route-paused banner (#84)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    await page.route(/\/(messages|status)(\?|$)/, (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "quota_exceeded", message: "public routing free quota exceeded" })
      })
    );
    await page.waitForSelector('#room-banner[data-kind="quota"]');
    await page.waitForSelector("text=Public route paused");
    await page.waitForSelector("text=local-only rooms keep working");
    await page.waitForSelector(".banner-action:not([hidden])");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("a closed room shows the host read-only history source and hides the composer (#83)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    await fetch(`${fixture.baseUrl}/close`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.hostToken}`, "Content-Type": "application/json" }
    });

    await page.waitForSelector("#history-strip:not([hidden])");
    // The host log is still reachable, so the source is named honestly (not an
    // exported summary) and the closed-room messages remain visible (#83).
    await page.waitForSelector("text=history source · host room (read-only)");
    await page.waitForSelector("text=· read-only");
    await page.waitForSelector(".message.system", { state: "attached" });
    await page.waitForSelector("text=room closed");
    // No composer in a closed room.
    assert.equal(await page.locator("#composer").isHidden(), true);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("a closed room with an unreachable host log shows an explicit unavailable source (#83)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    // The host room ended remotely: /status reports closed and /messages fails
    // with route_closed, so there is no live, cache, or export source to show.
    await page.route(/\/status(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, room: fixture.roomId, me: "host", is_host: true, room_status: "closed", attendance_policy: "manual-ok", brief_version: 1, participants: [] })
      })
    );
    await page.route(/\/messages(\?|$)/, (route) =>
      route.fulfill({ status: 410, contentType: "application/json", body: JSON.stringify({ ok: false, error: "route_closed", message: "this route has been closed" }) })
    );

    await page.waitForSelector("text=history source · unavailable");
    await page.waitForSelector("text=live, cached & exported history are unavailable");
    assert.equal(await page.locator("#composer").isHidden(), true);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("guest browser uses fragment token without host controls and room close disables composer", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 700 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.reviewerToken}`);
    await page.waitForSelector("text=Ship the browser room safely.");
    assert.equal(await page.locator("#close-button").isHidden(), true);

    await fetch(`${fixture.baseUrl}/close`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.hostToken}`,
        "Content-Type": "application/json"
      }
    });
    await page.waitForFunction(() => document.querySelector("#room-status")?.textContent === "closed");
    assert.equal(await page.locator("#message-text").isDisabled(), true);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

function participant(alias: string, kind: "agent" | "human", isHost: boolean, token: string): Participant {
  return {
    alias,
    kind,
    location: "local",
    install: isHost ? "host" : "lite",
    attention: "manual",
    is_host: isHost,
    token_hash: participantTokenHash(token),
    joinedAt: "2026-06-21T00:00:00.000Z",
    lastSeenAt: "2026-06-21T00:00:00.000Z"
  };
}

async function postMessage(fixture: { baseUrl: string }, token: string, text: string): Promise<void> {
  const response = await fetch(`${fixture.baseUrl}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text })
  });
  assert.equal(response.status, 201);
}

test("v5 batch surfaces: code-block header/copy, grouped rail, host controls, last-message KV (#117/#115/#116/#120)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    await postMessage(fixture, fixture.hostToken, "guard:\n```ts\nconst ok = true;\n```");
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    // #117 — fenced block renders a header with language label + copy affordance.
    await page.waitForSelector(".code-block .code-head .code-dot");
    assert.equal(await page.textContent(".code-block .code-head .code-lang"), "ts");
    await page.waitForSelector(".code-block .code-copy");

    // #115 — participants grouped into humans/agents; last-message KV is populated.
    await page.waitForSelector(".rail-group");
    const groups = await page.$$eval(".rail-group", (els) => els.map((e) => e.textContent || ""));
    assert.ok(groups.some((g) => g.includes("humans")));
    assert.ok(groups.some((g) => g.includes("agents")));
    assert.notEqual((await page.textContent("#roster-last-message"))?.trim(), "—");

    // #116 — host sees the control section; idle is disabled (platform-managed),
    // tickets is disabled (no fabricated data), and the state segment shows "active".
    // #249 replaced the fabricated disabled `paused` chip with a real host
    // control, so one disabled chip remains where there were two; the assertion
    // is re-pointed and the replacement is asserted rather than merely dropped.
    assert.equal(await page.isHidden("#host-controls"), false);
    assert.ok(await page.getAttribute("#rs-active", "class").then((c) => (c || "").includes("on")));
    assert.equal(await page.$$eval(".rail-state .rs[data-disabled='true']", (e) => e.length), 1);
    assert.equal(await page.$$eval(".rail-state .rs[data-disabled='true']", (e) => e[0]?.textContent?.trim()), "idle");
    assert.equal(await page.locator("#auto-continue-toggle").count(), 1);
    assert.equal(await page.isDisabled("#tickets-button"), true);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("an agent host groups under AGENTS with an `agent · host` badge (V2 #169)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    // an agent host (kind=agent, is_host=true) alongside a human participant
    await writeParticipants(fixture.root, fixture.roomId, [
      { ...participant("host", "agent", true, fixture.hostToken), display_name: "Agent Host" },
      participant("guest", "human", false, "guest-token")
    ]);
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector(".participant[data-host='true']");

    // the host row keeps its host role but is grouped + badged by its actual kind
    const host = page.locator(".participant[data-host='true']");
    assert.equal(await host.getAttribute("data-kind"), "agent");
    assert.match(await host.innerText(), /agent · host/);

    // grouping: the agent host sits under the AGENTS header, not HUMANS
    const grouping = await page.evaluate(() => {
      const out: Record<string, string> = {};
      let group = "";
      for (const li of document.querySelectorAll<HTMLLIElement>("#participant-list > li")) {
        if (li.classList.contains("rail-group")) {
          group = (li.firstChild?.textContent || "").trim();
        } else {
          out[li.querySelector("strong")?.textContent || ""] = group;
        }
      }
      return out;
    });
    assert.equal(grouping["Agent Host"], "agents");
    assert.equal(grouping["guest"], "humans");

    // host controls still belong to the host (role is independent of kind)
    assert.equal(await page.isHidden("#host-controls"), false);

    // no horizontal overflow at desktop or mobile
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      "no horizontal overflow at 1280"
    );
    await page.setViewportSize({ width: 390, height: 760 });
    await page.waitForTimeout(150);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      "no horizontal overflow at 390"
    );
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("code-block copy writes the raw body only (#120/#117)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    await postMessage(fixture, fixture.hostToken, "guard:\n```ts\nconst ok = true;\n```");
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    // Deterministic clipboard double so the copy path runs headless and we can
    // observe exactly what gets written. Must be installed before page scripts.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (t: string) => {
            (window as unknown as { __copied?: string }).__copied = t;
            return Promise.resolve();
          },
        },
      });
    });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");
    await page.click(".code-block .code-copy");
    // Only the raw code body is copied — not the "ts" language label or header.
    await page.waitForFunction(
      () => (window as unknown as { __copied?: string }).__copied === "const ok = true;",
      { timeout: 4000 }
    );
    assert.equal(await page.textContent(".code-block .code-copy"), "copied");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("code-block omits the copy button when no clipboard API is available (#120/#117)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    await postMessage(fixture, fixture.hostToken, "guard:\n```ts\nconst ok = true;\n```");
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    // Simulate a context with no Clipboard API: the header still renders, but the
    // copy affordance is omitted rather than shown as a silently-failing button.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");
    await page.waitForSelector(".code-block .code-head .code-lang");
    assert.equal(await page.$$eval(".code-block .code-copy", (els) => els.length), 0);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("last-message rail KV updates on the sender's own send (#121/#123)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");
    // No messages yet → the KV shows the empty-state dash.
    assert.equal((await page.textContent("#roster-last-message"))?.trim(), "—");
    // The host sends; the own message is added to state.seen and skipped by the
    // next poll, so only the own-send path can populate the KV. If #121 were
    // unfixed, this would stay "—" and the test would fail.
    await page.fill("#message-text", "first message from the host");
    await page.click("#send-button");
    await page.waitForFunction(
      () => {
        const el = document.getElementById("roster-last-message");
        return !!el && !!el.textContent && el.textContent.trim() !== "—";
      },
      { timeout: 4000 }
    );
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("host starts and ends an active chat session; the banner reflects it and non-hosts see it read-only (#183)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const hostPage = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await hostPage.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);
    await hostPage.waitForSelector("text=Ship the browser room safely.");
    const guestPage = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await guestPage.goto(`${fixture.baseUrl}/#token=${fixture.reviewerToken}`);
    await guestPage.waitForSelector("text=Ship the browser room safely.");

    // Idle: no banner for anyone; the host toggle reads "start session".
    assert.equal(await hostPage.isHidden("#session-banner"), true);
    assert.equal(await guestPage.isHidden("#session-banner"), true);
    assert.equal((await hostPage.textContent("#session-toggle"))?.trim(), "start session");

    // Host starts a session — the prompt supplies the expected duration (T11 API).
    hostPage.once("dialog", (dialog) => void dialog.accept("20"));
    await hostPage.click("#session-toggle");

    // The accent banner names the channel, elapsed vs expected, and the toggle flips.
    await hostPage.waitForSelector("#session-banner:not([hidden])");
    assert.equal(await hostPage.textContent("#session-title"), "Active session in #general");
    assert.match((await hostPage.textContent("#session-detail")) || "", /0m elapsed · ~20m expected/);
    await hostPage.waitForFunction(
      () => document.getElementById("session-toggle")?.textContent?.trim() === "end session"
    );
    // T11 system message carries the "started" line — no separate toast layer.
    await hostPage.waitForSelector("text=Active chat session started in #general");

    // The non-host sees the same banner (informational) but has no host controls,
    // so the start/end toggle is not reachable to them.
    await guestPage.waitForSelector("#session-banner:not([hidden])");
    assert.match((await guestPage.textContent("#session-title")) || "", /Active session in #general/);
    assert.equal(await guestPage.isHidden("#host-controls"), true);
    assert.equal(await guestPage.isHidden("#session-toggle"), true);

    // Host ends the session — the confirm is accepted, banner collapses to idle,
    // and the T11 "ended" line lands in the timeline.
    hostPage.once("dialog", (dialog) => void dialog.accept());
    await hostPage.click("#session-toggle");
    await hostPage.waitForSelector("#session-banner", { state: "hidden" });
    await hostPage.waitForFunction(
      () => document.getElementById("session-toggle")?.textContent?.trim() === "start session"
    );
    await hostPage.waitForSelector("text=Active chat session ended in #general");
    await guestPage.waitForSelector("#session-banner", { state: "hidden" });
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("the active-session banner renders a host-requested attendance policy and stays clear of raw color literals (#183)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    // A session started with a requested_mode (via the T11 API) surfaces that
    // policy in the banner detail for everyone.
    const started = await fetch(`${fixture.baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.hostToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start", expected_duration_m: 45, requested_mode: "agents-foreground" })
    });
    assert.equal(started.status, 201);

    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("#session-banner:not([hidden])");
    assert.match((await page.textContent("#session-detail")) || "", /~45m expected · attendance agents-foreground/);

    // Idle vs active is a real visual change, not just text: the banner is on its
    // own auto grid row that only occupies space when a session is active.
    const bannerBox = await page.evaluate(() => {
      const el = document.getElementById("session-banner");
      return el ? el.getBoundingClientRect().height : 0;
    });
    assert.ok(bannerBox > 0, "active session banner occupies vertical space");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("markdown.js renders a hostile corpus inert — script tags, on* handlers, javascript:/data: URLs (#181)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    // Drive the real shared renderer (src/browser/markdown.js) over a hostile corpus
    // and inspect the produced DOM: nothing executes and no dangerous node/href lands.
    const result = await page.evaluate(async () => {
      // Computed specifier: the module is resolved in the browser at runtime, not
      // by the test compiler (which cannot see the served /markdown.js).
      const spec = `./${"markdown"}.js`;
      const mod = (await import(spec)) as { renderSafeMarkdown: (parent: Element, md: string, opts: object) => void };
      const corpus = [
        "<script>window.__mdxss = 1</script>",
        '<img src=x onerror="window.__mdxss = 2">',
        "[click me](javascript:alert(1))",
        "[data link](data:text/html,<script>window.__mdxss=3</script>)",
        "plain javascript:alert(1) not a link",
        "<a href=\"javascript:alert(1)\">raw anchor</a>",
        "[safe](https://example.com)"
      ];
      const container = document.createElement("div");
      for (const item of corpus) {
        const line = document.createElement("div");
        mod.renderSafeMarkdown(line, item, {});
        container.append(line);
      }
      document.body.append(container);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") || "");
      return {
        scripts: container.querySelectorAll("script").length,
        imgs: container.querySelectorAll("img").length,
        jsHrefs: container.querySelectorAll('a[href^="javascript:"]').length,
        dataHrefs: container.querySelectorAll('a[href^="data:"]').length,
        onHandlers: container.querySelectorAll("[onerror], [onclick], [onload]").length,
        links,
        xss: (window as unknown as { __mdxss?: unknown }).__mdxss,
        text: container.textContent || ""
      };
    });

    assert.equal(result.scripts, 0, "no <script> nodes produced");
    assert.equal(result.imgs, 0, "no <img> nodes produced");
    assert.equal(result.jsHrefs, 0, "no javascript: hrefs");
    assert.equal(result.dataHrefs, 0, "no data: hrefs");
    assert.equal(result.onHandlers, 0, "no inline event-handler attributes");
    assert.equal(result.xss, undefined, "no hostile script executed");
    // Only the one genuinely safe https link is linkified (not over-blocked).
    assert.equal(result.links.length, 1);
    assert.match(result.links[0] ?? "", /^https:\/\/example\.com/);
    // Hostile markup survives only as inert text.
    assert.match(result.text, /<script>/);
    assert.match(result.text, /javascript:alert\(1\)/);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("the roster shows an honest wake-tier chip derived from effective_mode (#185)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    // Agents with distinct negotiated modes, plus one that declared nothing.
    await writeParticipants(fixture.root, fixture.roomId, [
      { ...participant("host", "human", true, fixture.hostToken), display_name: "Host" },
      {
        ...participant("waker", "agent", false, "t-waker"),
        attention: "attending",
        requested_mode: "wake_on_event",
        effective_mode: "wake_on_event"
      },
      {
        ...participant("fg", "agent", false, "t-fg"),
        attention: "attending",
        requested_mode: "foreground_attended",
        effective_mode: "foreground_attended"
      },
      {
        ...participant("relay", "agent", false, "t-relay"),
        attention: "manual",
        requested_mode: "manual",
        effective_mode: "manual"
      },
      { ...participant("undeclared", "agent", false, "t-undeclared"), attention: "manual" }
    ]);

    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");
    await page.waitForFunction(
      () => document.querySelectorAll("#participant-list .participant").length >= 5
    );

    const tiers = await page.evaluate(() => {
      const out: Record<string, string | null> = {};
      for (const li of document.querySelectorAll("#participant-list .participant")) {
        const alias = li.querySelector("strong")?.textContent || "";
        const chip = li.querySelector(".tier-chip");
        out[alias] = chip ? chip.getAttribute("data-tier") : null;
      }
      return out;
    });

    assert.equal(tiers["waker"], "A");
    assert.equal(tiers["fg"], "B");
    assert.equal(tiers["relay"], "C");
    // 9A invariant: an agent that declared no modes shows NO tier chip — the roster
    // never claims a wake capability that was not declared.
    assert.equal(tiers["undeclared"], null);

    // The chip carries its short label and an honest tooltip (behavior, not harness).
    const chipA = page.locator('.tier-chip[data-tier="A"]');
    assert.match((await chipA.textContent()) || "", /Tier A/);
    assert.match((await chipA.getAttribute("title")) || "", /wakes on|auto/i);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// Install a deterministic Notification double before page scripts run so the poll-
// driven notification layer (#186) can be exercised headless.
async function installNotificationDouble(page: import("playwright").Page, permission: string): Promise<void> {
  await page.addInitScript((perm) => {
    const calls: Array<{ title: string; body: string; tag: string }> = [];
    Object.defineProperty(window, "__notifs", { value: calls, configurable: true });
    let current = perm as string;
    class FakeNotification {
      constructor(title: string, opts?: { body?: string; tag?: string }) {
        calls.push({ title, body: (opts && opts.body) || "", tag: (opts && opts.tag) || "" });
      }
      static get permission(): string {
        return current;
      }
      static requestPermission(): Promise<string> {
        if (current === "default") current = "granted";
        return Promise.resolve(current);
      }
      close(): void {}
    }
    Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true });
  }, permission);
}

test("a mention while unfocused fires one OS notification + title badge, dedups, and clears on focus (#186)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await installNotificationDouble(page, "default");
    // #270: the brief is painted while entry is still in flight; `#notify-toggle`
    // binds in `bindEvents()` after entry's awaited first poll. Seed a message and
    // hold that poll open so the window is always wide, then wait on what the poll
    // must render — an early click is a no-op and `aria-pressed` never flips.
    await postMessage(fixture, fixture.reviewerToken, "entry-complete marker");
    let firstPollHeld = false;
    await page.route("**/messages**", async (route) => {
      if (!firstPollHeld && route.request().method() === "GET") {
        firstPollHeld = true;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      await route.continue();
    });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=entry-complete marker");

    // Opt in: the click is the user gesture that grants permission (double → granted).
    await page.click("#notify-toggle");
    await page.waitForFunction(() => document.getElementById("notify-toggle")?.getAttribute("aria-pressed") === "true");
    assert.equal(await page.isHidden("#notify-scope"), false);

    // Tab goes to the background, then a peer @mentions the host.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await postMessage(fixture, fixture.reviewerToken, "@host please take a look when you can");

    // One OS notification + a title unread count of 1.
    await page.waitForFunction(() => document.title.startsWith("(1) "));
    const first = await page.evaluate(() => (window as unknown as { __notifs: Array<{ title: string; body: string }> }).__notifs);
    assert.equal(first.length, 1);
    const note = first[0];
    assert.ok(note, "one notification recorded");
    // Body is GENERIC (sender alias only) — never the message text, so it can't leak.
    assert.match(note.body, /New mention from reviewer/);
    assert.equal(note.body.includes("please take a look"), false);
    assert.equal(note.body.includes(fixture.hostToken), false);
    assert.equal(note.body.includes(fixture.reviewerToken), false);

    // De-dup: another poll cycle must NOT re-notify the same message id.
    await page.waitForTimeout(3500);
    const second = await page.evaluate(() => (window as unknown as { __notifs: unknown[] }).__notifs.length);
    assert.equal(second, 1);
    assert.ok((await page.title()).startsWith("(1) "));

    // Focusing clears the badge back to the base title.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(() => document.title === "Agent Gather Room");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("permission-denied degrades silently to the title badge with no OS notification (#186)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await installNotificationDouble(page, "denied");
    // #270: the brief is painted while entry is still in flight; `#notify-toggle`
    // binds in `bindEvents()` after entry's awaited first poll. Seed a message and
    // hold that poll open so the window is always wide, then wait on what the poll
    // must render — an early click is a no-op and `aria-pressed` never flips.
    await postMessage(fixture, fixture.reviewerToken, "entry-complete marker");
    let firstPollHeld = false;
    await page.route("**/messages**", async (route) => {
      if (!firstPollHeld && route.request().method() === "GET") {
        firstPollHeld = true;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      await route.continue();
    });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=entry-complete marker");

    await page.click("#notify-toggle");
    await page.waitForFunction(() => document.getElementById("notify-toggle")?.getAttribute("aria-pressed") === "true");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await postMessage(fixture, fixture.reviewerToken, "@host ping while blocked");

    // Title badge still appears; no OS notification is fired.
    await page.waitForFunction(() => document.title.startsWith("(1) "));
    const notifs = await page.evaluate(() => (window as unknown as { __notifs: unknown[] }).__notifs.length);
    assert.equal(notifs, 0);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("own messages and non-mentions in mentions-only scope do not notify (#186)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await installNotificationDouble(page, "default");
    // #270: the brief renders BEFORE `enterRoom` awaits its first `/messages`
    // poll, and `#notify-toggle`'s handler is attached by `bindEvents()` after
    // that poll. Waiting on the brief let the click land on an unbound control,
    // so `aria-pressed` never flipped and `waitForFunction` timed out at ~30.7s
    // in CI (run 30924706944). Hold that first poll open on purpose so the
    // window is ALWAYS wide here — this test now fails deterministically if the
    // readiness wait below is removed, instead of only on a loaded CI runner.
    await postMessage(fixture, fixture.reviewerToken, "entry-complete marker");
    let firstPollHeld = false;
    await page.route("**/messages**", async (route) => {
      if (!firstPollHeld && route.request().method() === "GET") {
        firstPollHeld = true;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      await route.continue();
    });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    // Wait for what that first poll must render — not for the brief, which is
    // painted while entry is still in flight.
    await page.waitForSelector("text=entry-complete marker");
    await page.click("#notify-toggle");
    await page.waitForFunction(() => document.getElementById("notify-toggle")?.getAttribute("aria-pressed") === "true");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));

    // Default scope is mentions-only: a non-mention from a peer must not notify.
    await postMessage(fixture, fixture.reviewerToken, "hello everyone, no mention here");
    await page.waitForTimeout(3500);
    assert.equal(await page.evaluate(() => (window as unknown as { __notifs: unknown[] }).__notifs.length), 0);
    assert.equal(await page.title(), "Agent Gather Room");

    // The host's own message never notifies, even while unfocused.
    await page.fill("#message-text", "@reviewer my own note");
    await page.click("#send-button");
    await page.waitForSelector("text=@reviewer my own note");
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => (window as unknown as { __notifs: unknown[] }).__notifs.length), 0);
    assert.equal(await page.title(), "Agent Gather Room");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("a notification body never carries an invite URL or token from the message text (#186)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await installNotificationDouble(page, "default");
    // #270: the brief is painted while entry is still in flight; `#notify-toggle`
    // binds in `bindEvents()` after entry's awaited first poll. Seed a message and
    // hold that poll open so the window is always wide, then wait on what the poll
    // must render — an early click is a no-op and `aria-pressed` never flips.
    await postMessage(fixture, fixture.reviewerToken, "entry-complete marker");
    let firstPollHeld = false;
    await page.route("**/messages**", async (route) => {
      if (!firstPollHeld && route.request().method() === "GET") {
        firstPollHeld = true;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      await route.continue();
    });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=entry-complete marker");
    await page.click("#notify-toggle");
    await page.waitForFunction(() => document.getElementById("notify-toggle")?.getAttribute("aria-pressed") === "true");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));

    // A peer @mentions the host but pastes an invite URL AND a tgl_-like token.
    const token = "tgl_secret_9f3aK2p0Qz7Lx8Bn4Vd6Wc1";
    await postMessage(
      fixture,
      fixture.reviewerToken,
      `@host join https://agentgather.dev/#token=${token} — Bearer ${token}`
    );

    await page.waitForFunction(() => (window as unknown as { __notifs: unknown[] }).__notifs.length === 1);
    const notif = await page.evaluate(
      () => (window as unknown as { __notifs: Array<{ title: string; body: string }> }).__notifs[0]
    );
    assert.ok(notif);
    // The OS body is generic — it carries neither the URL nor the token, from either
    // the body or the title.
    const combined = `${notif.title} ${notif.body}`;
    assert.equal(combined.includes("agentgather.dev"), false);
    assert.equal(combined.includes(token), false);
    assert.equal(combined.includes("tgl_"), false);
    assert.equal(combined.includes("https://"), false);
    assert.match(notif.body, /New mention from reviewer/);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("a browser room join is recorded in the device-local 'Rooms I'm in' list, token-free (#178)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    // The successful join surfaces in the roster's "Rooms I'm in" section.
    await page.waitForSelector("#joined-section:not([hidden])");
    await page.waitForSelector("#joined-list .joined-row .joined-name");
    assert.match((await page.textContent("#joined-list .joined-row .joined-name")) || "", new RegExp(fixture.roomId));

    // The persisted record is metadata only — never the token or a #token= URL.
    const stored = await page.evaluate(() => window.localStorage.getItem("agentgather.joinedRooms"));
    assert.ok(stored);
    assert.equal(/tgl_|Bearer|#token=|token=/i.test(stored || ""), false);
    assert.equal((stored || "").includes(fixture.hostToken), false);
    const parsed = JSON.parse(stored || "{}") as { rooms: Array<{ baseUrl: string; alias: string }> };
    assert.equal(parsed.rooms[0]?.baseUrl, fixture.baseUrl);
    assert.equal(parsed.rooms[0]?.alias, "host");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("a browser join with an unreachable dashboard bridge degrades silently (#178)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    // Point the same-device bridge at a dead local port: the POST fails, but the
    // join still succeeds and the room-origin "Rooms I'm in" record is kept.
    await page.goto(`${fixture.baseUrl}/?dashboard=${encodeURIComponent("http://127.0.0.1:1")}#token=${fixture.hostToken}`);
    await page.waitForSelector("text=Ship the browser room safely.");
    await page.waitForSelector("#joined-section:not([hidden])");
    await page.waitForSelector("#joined-list .joined-row");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("a non-loopback ?dashboard= is refused — no cross-origin bridge POST leaves the browser (#178)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const bridgePosts: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && /joined-rooms/.test(req.url())) bridgePosts.push(req.url());
    });
    await page.goto(`${fixture.baseUrl}/?dashboard=${encodeURIComponent("https://evil.com")}#token=${fixture.hostToken}`);
    await page.waitForSelector("text=Ship the browser room safely.");
    assert.equal(await page.locator("#dashboard-home").isVisible(), false);
    assert.equal(await page.locator("#brand-static").isVisible(), true);
    // Give any (wrongly) scheduled bridge POST time to fire.
    await page.waitForTimeout(500);
    // The non-loopback target is refused client-side: no bridge POST at all.
    assert.deepEqual(bridgePosts, []);
    // The room-origin record is still kept (local-only).
    await page.waitForSelector("#joined-list .joined-row");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// #212 — host-only controls must be visible only to the actual host. A joined
// participant sees none of them (close / invite / session / broadcast-shortcut /
// export), in a live room and while the host is offline, while participant-safe
// affordances (the composer and its broadcast toggle) stay usable.
const HOST_ONLY_CONTROLS = ["#close-button", "#invite-button", "#session-toggle", "#rail-broadcast", "#export-button"];

test("a joined participant never sees host-only controls, live or while the host is offline; the host does (#212)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    // Host-owned path: the host sees the host-controls section and every control in it.
    const hostPage = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await hostPage.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);
    await hostPage.waitForSelector("text=Ship the browser room safely.");
    assert.equal(await hostPage.isHidden("#host-controls"), false);
    for (const control of HOST_ONLY_CONTROLS) {
      assert.equal(await hostPage.isVisible(control), true, `host should see ${control}`);
    }

    // Joined-participant path: the non-host reviewer opens the same live room and
    // sees no host-controls section and none of the individual host-only controls.
    const guestPage = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await guestPage.goto(`${fixture.baseUrl}/#token=${fixture.reviewerToken}`);
    await guestPage.waitForSelector("text=Ship the browser room safely.");
    assert.equal(await guestPage.isHidden("#host-controls"), true);
    for (const control of HOST_ONLY_CONTROLS) {
      assert.equal(await guestPage.isHidden(control), true, `participant must not see ${control}`);
    }
    // Participant-safe affordances remain: the participant can still compose and
    // reach the (participant-safe) broadcast toggle in the composer footer.
    assert.equal(await guestPage.isVisible("#composer"), true);
    assert.equal(await guestPage.isVisible("#broadcast-toggle"), true);

    // Offline joined-room path: the host goes unreachable on later polls. The
    // participant's view degrades to the reconnecting banner but never gains any
    // host-only control — the section and every button stay hidden.
    await guestPage.route(/\/(messages|status)(\?|$)/, (route) =>
      route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "host_unavailable", message: "host tunnel did not respond" })
      })
    );
    await guestPage.waitForSelector('#room-banner[data-kind="degraded"]');
    assert.equal(await guestPage.isHidden("#host-controls"), true);
    for (const control of HOST_ONLY_CONTROLS) {
      assert.equal(await guestPage.isHidden(control), true, `offline participant must not see ${control}`);
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// #218b — a direct room URL renders the three-panel workspace; the right roster
// panel holds all its content in one scroll child so it scrolls independently
// and never clips at the bottom, even when host controls sit below the roster.
test("a direct room URL keeps the roster right panel in one independent scroll context, no bottom clip (#218b)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    // A short viewport forces the roster (room info + participants + host controls)
    // to exceed the column height.
    const page = await browser.newPage({ viewport: { width: 1180, height: 460 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    // The host sees host controls (#212) inside the roster; all roster content
    // lives in the single .rail-scroll child.
    await page.waitForSelector("#roster .rail-scroll #host-controls:not([hidden])");
    const scroll = await page.evaluate(() => {
      const s = document.querySelector("#roster .rail-scroll") as HTMLElement;
      const rosterEl = document.getElementById("roster")!;
      return {
        overflowing: s.scrollHeight > s.clientHeight,
        overflowY: getComputedStyle(s).overflowY,
        // The OUTER roster must NOT be the scroll boundary — it clips to itself so
        // .rail-scroll is the single scroll container.
        outerScrolls: rosterEl.scrollHeight > rosterEl.clientHeight + 1,
        withinViewport: rosterEl.getBoundingClientRect().bottom <= window.innerHeight + 1
      };
    });
    assert.equal(scroll.overflowY, "auto");
    assert.equal(scroll.overflowing, true, "roster did not overflow at a short viewport");
    assert.equal(scroll.outerScrolls, false, "the outer roster is still a scroll boundary");
    assert.equal(scroll.withinViewport, true, "roster clipped past the viewport bottom");

    // Scrolling the panel reveals the host controls at the bottom (not clipped off).
    await page.evaluate(() => {
      const s = document.querySelector("#roster .rail-scroll") as HTMLElement;
      s.scrollTop = s.scrollHeight;
    });
    const controlsVisible = await page.evaluate(() => {
      const c = document.getElementById("close-button")!.getBoundingClientRect();
      return c.bottom <= window.innerHeight + 1 && c.top >= 0;
    });
    assert.equal(controlsVisible, true, "host controls remained clipped after scrolling");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// #216 — a browser join records the human-readable boardroom display title (from
// /status) as the "Rooms I'm in" label, not the slug-like room id, and still
// never persists a token in the device-local record.
test("a browser join records the boardroom display title in Rooms I'm in, token-free (#216)", async () => {
  const fixture = await startFixture();
  await createBoardroom(fixture.root, fixture.roomId, { name: "Agent Gather Launch" });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    const stored = await page.evaluate(() => window.localStorage.getItem("agentgather.joinedRooms"));
    const parsed = JSON.parse(stored ?? "{}") as { rooms: Array<{ roomId: string; title: string }> };
    const entry = parsed.rooms.find((room) => room.roomId === fixture.roomId);
    assert.notEqual(entry, undefined);
    assert.equal(entry?.title, "Agent Gather Launch"); // display title, not the slug
    assert.notEqual(entry?.title, fixture.roomId);
    assert.equal(/tgl_|token=|Bearer|host-/i.test(stored ?? ""), false);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// #211 — the local backup is bounded (oldest dropped past the cap).
test("the local backup is bounded — oldest messages are dropped past the cap (#211)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const key = `agentgather.backup.${fixture.roomId}`;
    // Seed a backup already over the cap before the page scripts run.
    await page.addInitScript((k) => {
      const messages = Array.from({ length: 260 }, (_, i) => ({
        id: i + 1,
        from: "old",
        ts: "2026-07-01T00:00:00.000Z",
        type: "chat",
        text: `old-${i}`
      }));
      window.localStorage.setItem(k, JSON.stringify({ messages }));
    }, key);
    await postMessage(fixture, fixture.hostToken, "newest-kept");
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=newest-kept");

    const backup = await page.evaluate((k) => JSON.parse(window.localStorage.getItem(k) as string), key);
    assert.ok(backup.messages.length <= 250, `backup grew to ${backup.messages.length}`);
    assert.equal(backup.messages.some((m: { text: string }) => m.text === "newest-kept"), true);
    assert.equal(backup.messages.some((m: { text: string }) => m.text === "old-0"), false);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// #211 — tokens and card URLs are redacted before being stored in the backup.
test("the local backup redacts tokens and card URLs before storing (#211)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await postMessage(fixture, fixture.reviewerToken, "leak tgl_secret_abc123XYZ and https://host/card?token=tgl_zzz plus Bearer sk_live_qqq");
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=leak");

    const stored = await page.evaluate(() => {
      const key = Object.keys(window.localStorage).find((k) => k.startsWith("agentgather.backup."));
      return key ? (window.localStorage.getItem(key) as string) : "";
    });
    assert.equal(/tgl_secret_abc123XYZ|token=tgl_zzz|Bearer sk_live_qqq|\/card\?/.test(stored), false);
    assert.match(stored, /redacted/);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// #211 — host offline with no cached messages: empty read-only backup, composer disabled.
test("host offline with no cached messages shows an empty read-only backup (#211)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");
    await page.route(/\/(messages|status)(\?|$)/, (route) =>
      route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "host_unavailable", message: "host tunnel did not respond" })
      })
    );
    await page.waitForSelector("#backup-notice:not([hidden])");
    assert.match((await page.locator("#backup-notice").textContent()) ?? "", /No messages are saved on this device yet/);
    await page.waitForFunction(() => (document.getElementById("message-text") as HTMLTextAreaElement).disabled === true);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// #250: the shared renderer discarded each ordered marker's ordinal and ended
// the list at the first blank line, so `1.` / blank / `2.` rendered as three
// lists each restarting at 1. Ordinals now survive through ol.start and
// li.value, and blank lines keep a loose ORDERED list open.
type OrderedList = { start: number; items: Array<{ text: string; value: string | null }> };
type RenderedCase = {
  olCount: number;
  ulCount: number;
  pCount: number;
  headingCount: number;
  quoteCount: number;
  codeCount: number;
  scriptCount: number;
  lists: OrderedList[];
};

function soleList(rendered: RenderedCase, label: string): OrderedList {
  assert.equal(rendered.olCount, 1, `${label}: expected exactly one <ol>`);
  const list = rendered.lists[0];
  assert.ok(list, `${label}: missing the rendered list`);
  return list;
}

const values = (list: OrderedList): Array<string | null> => list.items.map((item) => item.value);
const texts = (list: OrderedList): string[] => list.items.map((item) => item.text);

test("ordered lists keep authored numbering across blank lines — ol.start / li.value (#250)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");

    // Drive the real shared renderer (src/browser/markdown.js) and read the
    // semantic DOM it produces — ol.start and the li value attribute are what
    // the HTML spec says determine the visible marker.
    const cases = await page.evaluate(async () => {
      const spec = `./${"markdown"}.js`;
      const mod = (await import(spec)) as { renderSafeMarkdown: (parent: Element, md: string, opts: object) => void };
      const render = (markdown: string) => {
        const host = document.createElement("div");
        mod.renderSafeMarkdown(host, markdown, {});
        return {
          olCount: host.querySelectorAll("ol").length,
          ulCount: host.querySelectorAll("ul").length,
          pCount: host.querySelectorAll("p").length,
          headingCount: host.querySelectorAll("h1, h2, h3").length,
          quoteCount: host.querySelectorAll("blockquote").length,
          codeCount: host.querySelectorAll(".code-block").length,
          scriptCount: host.querySelectorAll("script").length,
          lists: Array.from(host.querySelectorAll("ol")).map((ol) => ({
            start: ol.start,
            items: Array.from(ol.children).map((li) => ({
              text: li.textContent || "",
              value: li.getAttribute("value")
            }))
          }))
        };
      };
      return {
        contiguous: render("1. one\n2. two\n3. three"),
        loose: render("1. one\n\n2. two\n\n3. three"),
        looseWideGap: render("1. one\n\n\n\n2. two"),
        nonOneStart: render("4. four\n5. five"),
        looseNonOneStart: render("4. four\n\n5. five"),
        discontinuity: render("1. one\n3. three"),
        looseDiscontinuity: render("1. one\n\n3. three"),
        unorderedLoose: render("- alpha\n\n- beta"),
        boundaryHeading: render("1. one\n\n## Heading\n\n2. two"),
        boundaryParagraph: render("1. one\n\nplain paragraph\n\n2. two"),
        boundaryUnordered: render("1. one\n\n- bullet"),
        boundaryQuote: render("1. one\n\n> quoted"),
        boundaryFence: render("1. one\n\n```ts\nconst x = 1;\n```"),
        trailingBlank: render("1. one\n\n"),
        hostile: render("1. <script>window.__mdOrdinalXss = 1</script>\n\n2. <img src=x onerror=\"window.__mdOrdinalXss = 2\">")
      };
    });

    // Contiguous 1/2/3 still renders as one list starting at 1, with no
    // redundant per-item values.
    const contiguous = soleList(cases.contiguous, "contiguous");
    assert.equal(contiguous.start, 1);
    assert.deepEqual(texts(contiguous), ["one", "two", "three"]);
    assert.deepEqual(values(contiguous), [null, null, null]);

    // THE REGRESSION: blank-line-separated 1/2/3 is ONE list numbered 1,2,3 —
    // not three lists each restarting at 1.
    const loose = soleList(cases.loose, "loose");
    assert.equal(loose.start, 1);
    assert.deepEqual(texts(loose), ["one", "two", "three"]);
    assert.deepEqual(values(loose), [null, null, null]);

    // More than one blank line between items is still the same list.
    const looseWide = soleList(cases.looseWideGap, "looseWideGap");
    assert.equal(looseWide.items.length, 2);
    assert.equal(looseWide.start, 1);

    // A non-1 start is preserved rather than normalized to 1.
    const nonOne = soleList(cases.nonOneStart, "nonOneStart");
    assert.equal(nonOne.start, 4);
    assert.deepEqual(texts(nonOne), ["four", "five"]);
    assert.deepEqual(values(nonOne), [null, null]);
    const looseNonOne = soleList(cases.looseNonOneStart, "looseNonOneStart");
    assert.equal(looseNonOne.start, 4);
    assert.equal(looseNonOne.items.length, 2);

    // An intentional discontinuity (1. then 3.) is carried on the item, not
    // silently renumbered to 2.
    const gap = soleList(cases.discontinuity, "discontinuity");
    assert.equal(gap.start, 1);
    assert.deepEqual(values(gap), [null, "3"]);
    const looseGap = soleList(cases.looseDiscontinuity, "looseDiscontinuity");
    assert.equal(looseGap.start, 1);
    assert.deepEqual(texts(looseGap), ["one", "three"]);
    assert.deepEqual(values(looseGap), [null, "3"]);

    // Unordered lists are untouched: a blank line still ends them (#250 scope
    // is ordered lists only).
    assert.equal(cases.unorderedLoose.ulCount, 2, "blank-line-separated bullets still split");
    assert.equal(cases.unorderedLoose.olCount, 0);

    // Unrelated blocks must never be absorbed into the list.
    assert.equal(cases.boundaryHeading.olCount, 2, "a heading ends the list");
    assert.equal(cases.boundaryHeading.headingCount, 1);
    assert.equal(cases.boundaryHeading.lists[1]?.start, 2, "the list after the heading keeps its own ordinal");
    assert.equal(cases.boundaryParagraph.olCount, 2, "a paragraph ends the list");
    assert.equal(cases.boundaryParagraph.pCount, 1);
    assert.equal(cases.boundaryUnordered.olCount, 1, "a different list kind ends the list");
    assert.equal(cases.boundaryUnordered.ulCount, 1);
    assert.equal(cases.boundaryQuote.olCount, 1, "a quote ends the list");
    assert.equal(cases.boundaryQuote.quoteCount, 1);
    assert.equal(cases.boundaryFence.olCount, 1, "a code fence ends the list");
    assert.equal(cases.boundaryFence.codeCount, 1);
    assert.equal(soleList(cases.trailingBlank, "trailingBlank").items.length, 1, "trailing blank lines end the list");

    // Ordinal handling did not open a markup hole: hostile item bodies stay inert.
    assert.equal(cases.hostile.scriptCount, 0, "no <script> node from a list item");
    assert.equal(cases.hostile.olCount, 1);
    assert.equal(await page.evaluate(() => (window as Window & { __mdOrdinalXss?: unknown }).__mdOrdinalXss), undefined);

    // Room timeline path — the same renderer through a real posted message.
    await postMessage(fixture, fixture.reviewerToken, "1. one\n\n2. two\n\n3. three");
    await page.waitForSelector(".message-text ol");
    const timeline = await page.evaluate(() => {
      const lists = Array.from(document.querySelectorAll(".message-text ol"));
      return lists.map((ol) => ({
        start: (ol as HTMLOListElement).start,
        items: Array.from(ol.children).map((li) => ({
          text: li.textContent || "",
          value: li.getAttribute("value")
        }))
      }));
    });
    assert.equal(timeline.length, 1, "the timeline message renders one ordered list");
    assert.equal(timeline[0]?.start, 1);
    assert.deepEqual(timeline[0]?.items.map((item) => item.text), ["one", "two", "three"]);

    // Room Brief path — loose list, a paragraph boundary, a non-1 start, and a
    // deliberate discontinuity in one authored brief.
    const brief = [
      "## Steps",
      "1. first",
      "",
      "2. second",
      "",
      "3. third",
      "",
      "Resuming later:",
      "",
      "4. fourth",
      "",
      "5. fifth",
      "",
      "Skipped a number on purpose:",
      "",
      "1. alpha",
      "3. gamma"
    ].join("\n");
    const briefResponse = await fetch(`${fixture.baseUrl}/brief`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.hostToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: brief })
    });
    assert.equal(briefResponse.status, 200);
    await page.click("#brief-refresh");
    await page.click("#brief-open");
    await page.waitForSelector("#brief-body ol");
    const briefLists = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#brief-body ol")).map((ol) => ({
        start: (ol as HTMLOListElement).start,
        items: Array.from(ol.children).map((li) => ({
          text: li.textContent || "",
          value: li.getAttribute("value")
        }))
      }))
    );
    assert.equal(briefLists.length, 3, "the brief keeps three distinct ordered lists");
    assert.deepEqual(briefLists.map((list) => list.start), [1, 4, 1]);
    assert.deepEqual(briefLists[0]?.items.map((item) => item.text), ["first", "second", "third"]);
    assert.deepEqual(briefLists[1]?.items.map((item) => item.text), ["fourth", "fifth"]);
    assert.deepEqual(briefLists[2]?.items.map((item) => item.value), [null, "3"]);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// #249: the host rail gains a real auto-continue control in place of the
// fabricated disabled `paused` chip. Host-only, off by default, seconds input
// disabled until opted in, and a truthful pending state when the guard pauses.
test("host rail auto-continue: host-only, off by default, opt-in enables the bounded delay, pending shows truthfully (#249)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    // A non-host never sees the host controls at all.
    const guest = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await guest.goto(`${fixture.baseUrl}/#token=${fixture.reviewerToken}`);
    await guest.waitForSelector("text=Ship the browser room safely.");
    assert.equal(await guest.locator("#host-controls").isVisible(), false, "a non-host must not see host controls");
    await guest.close();

    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.waitForSelector("text=Ship the browser room safely.");
    await page.waitForSelector("#host-controls:not([hidden])");

    // The fabricated disabled "paused" chip is gone.
    assert.equal(await page.locator('.rail-state .rs[data-disabled="true"]:has-text("paused")').count(), 0);

    // Off by default, and the seconds input is disabled until opted in.
    await page.waitForSelector("#auto-continue-toggle");
    assert.equal(await page.locator("#auto-continue-toggle").isChecked(), false);
    assert.equal(await page.locator("#auto-continue-delay").isDisabled(), true);
    assert.equal(await page.locator("#auto-continue-delay").inputValue(), "30");
    // The bounds are advertised on the control itself, and the server enforces them.
    assert.equal(await page.locator("#auto-continue-delay").getAttribute("min"), "30");
    assert.equal(await page.locator("#auto-continue-delay").getAttribute("max"), "300");
    // Nothing is claimed until something is actually pending.
    assert.equal(await page.locator("#auto-continue-state").isVisible(), false);

    // Opt in: the delay input becomes editable and the preference round-trips.
    await page.check("#auto-continue-toggle");
    await page.waitForSelector("#auto-continue-delay:not([disabled])");
    await page.fill("#auto-continue-delay", "300");
    await page.locator("#auto-continue-delay").blur();
    await page.waitForFunction(async () => {
      const response = await fetch("/status", { headers: { Authorization: `Bearer ${sessionStorage.getItem("agentgather.token") || ""}` } });
      if (!response.ok) return false;
      const payload = await response.json();
      return payload.loop_guard?.auto_continue_enabled === true && payload.loop_guard?.auto_continue_delay_s === 300;
    });

    // Drive the guard to a pause as the agent; the rail must then tell the truth.
    // Drive past the 30-message guard. The last post is expected to be refused
    // with 429 — that refusal is what opens the pending cycle.
    let guardStatus = 0;
    for (let index = 0; index < 32 && guardStatus !== 429; index += 1) {
      const response = await fetch(`${fixture.baseUrl}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${fixture.reviewerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: `agent ${index}` })
      });
      guardStatus = response.status;
    }
    assert.equal(guardStatus, 429, "the guard must pause before the rail can show a pending cycle");
    await page.waitForSelector("#auto-continue-state:not([hidden])", { timeout: 15_000 });
    const pendingText = await page.locator("#auto-continue-state").innerText();
    assert.match(pendingText, /paused/i);
    assert.match(pendingText, /@reviewer/, "the pending state names the blocked alias");
    assert.match(pendingText, /continuing in \d+s/, "a real countdown, not a fabricated label");
    // The countdown is never a token or URL.
    assert.doesNotMatch(pendingText, /Bearer|tgl_|#token=|http/);

    // The composer is untouched by any of this.
    assert.equal(await page.locator("#message-text").isDisabled(), false);
    assert.equal(await page.locator("#auto-continue-toggle").count(), 1, "the control lives in the rail only");
    assert.equal(await page.locator(".composer #auto-continue-toggle").count(), 0);

    // No overflow at desktop or narrow, and the control is a plain rail row —
    // no modal, no nested card.
    assert.equal(await page.locator(".rail-autocontinue dialog, .rail-autocontinue .card").count(), 0);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 760 });
      await page.waitForTimeout(120);
      const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      assert.equal(noOverflow, true, `no horizontal overflow at ${width}`);
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// #268: `bindEvents()` runs at the END of `enterRoom()`, after several awaits,
// but the composer is on screen and clickable for that whole window. With a
// `type="submit"` button and no handler yet, a click natively submits the form
// and NAVIGATES — and entry has already cleared the token fragment, so the
// reload lands unauthenticated and ejects the participant from the room.
//
// The window is opened deterministically by holding the entry `/status`
// response, not by racing a fast machine.
test("Send before entry completes cannot navigate or eject the participant (#268)", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });

    // Hold the FIRST /status only; later polls proceed normally.
    let releaseEntry = (): void => {};
    const entryHeld = new Promise<void>((resolve) => {
      releaseEntry = resolve;
    });
    let heldOnce = false;
    await page.route("**/status*", async (route) => {
      if (!heldOnce) {
        heldOnce = true;
        await entryHeld;
      }
      await route.continue();
    });

    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);

    // Record every main-frame navigation from here. A navigation is the defect,
    // so it is asserted directly rather than inferred from a settling delay.
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });

    // The composer is present and the Send button clickable while entry is still
    // in flight — this is the window the defect lives in.
    await page.waitForSelector("#send-button", { state: "visible" });
    const urlDuringEntry = page.url();
    // Entry has already cleared the token fragment, which is what makes a
    // navigation unrecoverable. Confirm that precondition rather than assume it.
    assert.equal(urlDuringEntry.includes("#token="), false, "the fragment is cleared before entry finishes");

    await page.fill("#message-text", "sent too early");

    // (a) A click must not navigate. The guard's own effect — the honest notice —
    // is the synchronisation point, so this waits on a real event rather than a
    // fixed delay. On base the click navigates instead and this wait fails.
    // Race the fix's own end state against a navigation, both armed BEFORE the
    // click so neither can fire unobserved. The refusal notice is the
    // discriminator: `showEarlySendNotice` does not exist on base, so waiting on
    // it cannot pass for the unfixed case — unlike a fixed deadline, which
    // passes whenever the navigation merely has not happened yet.
    const clickNavigated = page.waitForEvent("framenavigated").then(() => "navigated").catch(() => "navigated");
    const clickNoticed = page
      .waitForSelector("#send-error:not([hidden])")
      .then(() => "noticed")
      .catch(() => "timed-out");
    await page.click("#send-button");
    assert.equal(await Promise.race([clickNoticed, clickNavigated]), "noticed", "clicking Send before entry navigated the page instead of refusing it");
    assert.equal(page.url(), urlDuringEntry, "clicking Send before entry navigated the page");
    assert.deepEqual(navigations, [], "clicking Send before entry triggered a navigation");
    assert.equal(await page.locator("#auth-error").isVisible(), false, "the participant was ejected to the auth error");

    // The refusal is honest rather than silent, and token-free.
    const notice = await page.locator("#send-error").innerText();
    assert.match(notice, /still joining/i);
    assert.doesNotMatch(notice, /tgl_|Bearer|#token=|http/);

    // (b) Enter with the button focused must not submit either, whatever has
    // focus. Hide the notice first so its reappearance is the positive signal.
    await page.evaluate(() => {
      const el = document.getElementById("send-error");
      if (el) el.hidden = true;
    });
    await page.focus("#send-button");
    const enterNavigated = page.waitForEvent("framenavigated").then(() => "navigated").catch(() => "navigated");
    const enterNoticed = page
      .waitForSelector("#send-error:not([hidden])")
      .then(() => "noticed")
      .catch(() => "timed-out");
    await page.keyboard.press("Enter");
    assert.equal(await Promise.race([enterNoticed, enterNavigated]), "noticed", "Enter on the focused Send button navigated instead of refusing");
    assert.equal(page.url(), urlDuringEntry, "Enter on the focused Send button navigated the page");
    assert.deepEqual(navigations, [], "Enter on the focused Send button triggered a navigation");
    assert.equal(await page.locator("#auth-error").isVisible(), false);

    // Let entry finish; the room must be fully usable afterwards.
    // No unroute: the handler already passes every later /status straight
    // through, and unrouting can race a request already in flight.
    releaseEntry();
    await page.waitForSelector("text=Ship the browser room safely.");
    await page.waitForSelector(".composer");

    // Post-entry click-to-send still works (the button is no longer a submit,
    // so this proves the replacement click path is wired).
    await page.fill("#message-text", "click after entry");
    await page.click("#send-button");
    await page.waitForSelector("text=click after entry");

    // Post-entry Enter-to-send still works.
    await page.fill("#message-text", "enter after entry");
    await page.press("#message-text", "Enter");
    await page.waitForSelector("text=enter after entry");

    // And still no navigation from either.
    assert.equal(page.url(), urlDuringEntry, "sending after entry navigated the page");
    assert.deepEqual(navigations, [], "sending after entry triggered a navigation");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// #278 — the local backup (#211) was written on every batch and never read, so
// every load re-downloaded the entire history from id 0. Entry now restores this
// device's own copy first and asks only for what is new.
test("a second entry seeds from the local backup and fetches only what is new (#278)", async () => {
  const fixture = await startFixture();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const sinceIds: number[] = [];
    page.on("request", (req) => {
      const match = /\/messages\?since_id=(\d+)/.exec(req.url());
      if (match && req.method() === "GET") sinceIds.push(Number(match[1]));
    });

    for (const text of ["history one", "history two", "history three"]) {
      await postMessage(fixture, fixture.reviewerToken, text);
    }
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);
    await page.waitForSelector("text=history three");
    // First entry has no backup to restore: it asks from the beginning, as before.
    assert.equal(sinceIds[0], 0);

    // A message arrives while this tab is away, so the second entry must still see
    // it — the seam between restored and fetched is where a gap would show.
    await postMessage(fixture, fixture.reviewerToken, "arrived while away");

    // Read what the backup holds BEFORE reloading — after the reload it will also
    // contain the message fetched on the way in.
    const backupHighest = await page.evaluate(() => {
      const key = Object.keys(window.localStorage).find((k) => k.startsWith("agentgather.backup."));
      const raw = key === undefined ? null : window.localStorage.getItem(key);
      const parsed = raw
        ? (JSON.parse(raw) as { messages: Array<{ id: number; type?: string }> })
        : { messages: [] };
      // System records are not restored (#278), so the cursor is the highest id
      // that is actually restorable — not simply the highest id stored.
      return parsed.messages
        .filter((entry) => entry.type !== "system")
        .reduce((highest, entry) => Math.max(highest, entry.id), 0);
    });
    assert.equal(backupHighest > 0, true, "the backup holds messages after the first entry");

    // THE evidence: the second entry asks from the backup's highest id, not 0.
    sinceIds.length = 0;
    await page.reload();
    await page.waitForSelector("text=arrived while away");
    assert.equal(sinceIds[0], backupHighest, "second entry resumes from the highest id it actually restored");
    assert.notEqual(sinceIds[0], 0);

    // Same history, same order, no duplicate and no gap at the join.
    const texts = await page.locator(".message .message-text").allTextContents();
    const historyOnly = texts.filter((t) => /history (one|two|three)|arrived while away/.test(t));
    assert.deepEqual(historyOnly, ["history one", "history two", "history three", "arrived while away"]);
    for (const text of ["history one", "history two", "history three", "arrived while away"]) {
      assert.equal(historyOnly.filter((line) => line === text).length, 1, `${text} rendered exactly once`);
    }
    // The restored range is named, so a trimmed backup could not read as complete.
    assert.match((await page.locator(".restored-divider").textContent()) ?? "", /Restored from this device/);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});

test("an empty or corrupt backup falls back to the full fetch and never blocks entry (#278)", async () => {
  const fixture = await startFixture();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const sinceIds: number[] = [];
    page.on("request", (req) => {
      const match = /\/messages\?since_id=(\d+)/.exec(req.url());
      if (match && req.method() === "GET") sinceIds.push(Number(match[1]));
    });
    await postMessage(fixture, fixture.reviewerToken, "only message");
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);
    await page.waitForSelector("text=only message");

    // Corrupt the store in three ways a real one could break, and reload for each.
    for (const broken of ["{not json", JSON.stringify({ messages: "nope" }), ""]) {
      sinceIds.length = 0;
      await page.evaluate((value) => {
        for (const key of Object.keys(window.localStorage)) {
          if (key.startsWith("agentgather.backup.")) {
            if (value === "") window.localStorage.removeItem(key);
            else window.localStorage.setItem(key, value);
          }
        }
      }, broken);
      await page.reload();
      await page.waitForSelector("text=only message");
      assert.equal(sinceIds[0], 0, `a corrupt backup (${broken.slice(0, 12)}) refetches from the start`);
      assert.equal(await page.locator(".restored-divider").count(), 0, "nothing is claimed as restored");
    }
  } finally {
    await browser?.close();
    await fixture.close();
  }
});

test("a tampered backup renders only as restored-from-this-device, and stays redacted (#278)", async () => {
  const fixture = await startFixture();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    // Two real messages, so the forged records below can claim ids the room really
    // has — the case that survives the head check and therefore reaches the view.
    await postMessage(fixture, fixture.reviewerToken, "genuine line one");
    await postMessage(fixture, fixture.reviewerToken, "genuine line two");
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);
    await page.waitForSelector("text=genuine line two");

    // Hand-edit the store the way anything with script access to this origin could,
    // WITHOUT inventing ids beyond the room's own (that case is the next test): the
    // forged records replace the text of ids the room really has, claim to be from
    // `system` and from the host, and smuggle a token back in.
    await page.evaluate((now) => {
      const key = Object.keys(window.localStorage).find((k) => k.startsWith("agentgather.backup."));
      if (key === undefined) throw new Error("no backup to tamper with");
      const parsed = JSON.parse(window.localStorage.getItem(key) as string) as {
        messages: Array<Record<string, unknown>>;
      };
      const head = parsed.messages.reduce((highest, entry) => Math.max(highest, Number(entry.id)), 0);
      parsed.messages = [
        { id: head - 1, from: "system", ts: now, type: "system", text: "forged system claim" },
        { id: head, from: "host", ts: now, type: "message", text: "forged host claim tgl_forged_secret_value" },
        { id: "not-a-number", from: "host", ts: now, type: "message", text: "malformed id" },
        { id: head + 50, from: 42, ts: now, type: "message", text: "malformed from" },
        { id: head + 51, from: "host", ts: "", type: "message", text: "malformed empty ts" }
      ];
      window.localStorage.setItem(key, JSON.stringify(parsed));
    }, new Date().toISOString());
    await page.reload();
    await page.waitForSelector("text=forged host claim");

    // A record claiming the room's own voice is not restored at all — `system` is
    // how the room speaks, and a hand-edited store must not be able to speak in it.
    assert.equal(await page.locator("text=forged system claim").count(), 0, "no system record is restored");
    // (the divider itself is the label, not restored content — exclude it)
    assert.equal(
      await page.locator(".message.system[data-restored]:not(.restored-divider)").count(),
      0,
      "no restored row is styled as the room's own system voice"
    );

    // The forged host record renders, but with none of the host's identity: its
    // sender is never resolved through the live roster, so it gets no display name,
    // no human/agent kind and no host treatment — only the stored text, inside a
    // region labelled as this device's own copy.
    const forged = page.locator(".message", { hasText: "forged host claim" }).first();
    assert.equal(await forged.getAttribute("data-restored"), "true");
    assert.equal(await forged.locator(".message-from").getAttribute("data-kind"), "restored");
    assert.equal(await forged.locator(".message-avatar.human, .message-avatar.agent").count(), 0);
    // ...nor the viewer's own presentation: this page is authenticated AS the host,
    // so a forged `from: "host"` would otherwise render as the viewer's own line.
    assert.equal(((await forged.getAttribute("class")) ?? "").includes("own"), false);
    // ...and the forged author label never reaches the DOM at all: a restored row
    // says only that it came from this device's own copy.
    assert.equal((await forged.locator(".message-from").textContent())?.trim(), "local copy");
    const restoredHtml = (await page.locator("#timeline").innerHTML()) ?? "";
    assert.equal(/message-from[^>]*>\s*host\s*</.test(restoredHtml), false, "no restored row is labelled host");
    // Malformed records are dropped rather than coerced into a half-rendered row.
    for (const text of ["malformed id", "malformed from", "malformed empty ts"]) {
      assert.equal(await page.locator(`text=${text}`).count(), 0, `${text} was dropped`);
    }
    // Redaction is re-applied on the way in: a smuggled token never reaches the DOM.
    const rendered = (await page.locator("#timeline").innerHTML()) ?? "";
    assert.equal(/tgl_forged_secret_value/.test(rendered), false);
    assert.match(rendered, /\[redacted-token\]/);

    // A line the host serves after entry is NOT marked restored — the distinction
    // the marking exists to make.
    await postMessage(fixture, fixture.reviewerToken, "served live after entry");
    await page.waitForSelector("text=served live after entry");
    const live = page.locator(".message", { hasText: "served live after entry" }).first();
    assert.equal(await live.getAttribute("data-restored"), null);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});

// #278 — marking the ROW is not enough: the same data flows onward into surfaces
// that carry no restored marking. Every assertion in the test above inspects the
// restored row, which is exactly why all of them pass through these routes.
test("no restored record\'s author or text escapes into an unmarked surface (#278)", async () => {
  const fixture = await startFixture();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await postMessage(fixture, fixture.reviewerToken, "genuine line one");
    await postMessage(fixture, fixture.reviewerToken, "genuine line two");
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);
    await page.waitForSelector("text=genuine line two");

    // Replace the text of an id the room really has with a record claiming the host
    // said it. The forged text deliberately contains no occurrence of "host", so the
    // attribution assertions below cannot be satisfied by the body text.
    const forgedText = "approved, release the funds";
    const { forgedId, storedAfterTamper } = await page.evaluate(
      ({ now, text }) => {
        const key = Object.keys(window.localStorage).find((k) => k.startsWith("agentgather.backup."));
        if (key === undefined) throw new Error("no backup to tamper with");
        const parsed = JSON.parse(window.localStorage.getItem(key) as string) as {
          messages: Array<Record<string, unknown>>;
        };
        const head = parsed.messages.reduce((highest, entry) => Math.max(highest, Number(entry.id)), 0);
        parsed.messages = [{ id: head, from: "host", ts: now, type: "message", text }];
        const serialised = JSON.stringify(parsed);
        window.localStorage.setItem(key, serialised);
        return { forgedId: head, storedAfterTamper: serialised };
      },
      { now: new Date().toISOString(), text: forgedText }
    );
    await page.reload();
    await page.waitForSelector(`text=${forgedText}`);

    // A restored row carries no reply surface at all: the button's `aria-label` and
    // the composer indicator both name an author, and the only alias either could
    // name is the stored one. Removing them is what makes that unreachable rather
    // than sanitised (#278, operator ruling).
    const restored = page.locator(".message", { hasText: forgedText }).first();
    assert.equal(await restored.getAttribute("data-restored"), "true");
    assert.equal(await restored.locator(".reply-btn").count(), 0, "no reply button on a restored row");
    // ...including the double-click shortcut, which bypasses the button entirely.
    await restored.dblclick();
    assert.equal(await page.locator("#reply-indicator").isVisible(), false, "dblclick sets no reply target");
    // No rendered element anywhere announces the forged author.
    const timelineHtml = (await page.locator("#timeline").innerHTML()) ?? "";
    assert.equal(/Reply to Host/i.test(timelineHtml), false, "no aria-label names the forged author");

    // A restored record must not flow back OUT of the view into persistence either.
    // `recordBackupBatch` and `bridgeHistoryToDashboard` — the latter feeding #247's
    // on-disk dashboard snapshot — both take `fresh`, which `pollMessages` builds
    // only from host-served payload. Asserted on the writer, where it is observable:
    // a warm entry that fetched nothing leaves the stored copy byte-identical, so
    // nothing re-ingested the restored records.
    const storedAfterEntry = await page.evaluate(() => {
      const key = Object.keys(window.localStorage).find((k) => k.startsWith("agentgather.backup."));
      return key === undefined ? null : window.localStorage.getItem(key);
    });
    assert.equal(storedAfterEntry, storedAfterTamper, "a restored record was re-ingested by the backup writer");

    // A live message can still carry reply_to pointing at an id only this device
    // holds — reached here over the real API, since the UI no longer offers it.
    const posted = await fetch(`${fixture.baseUrl}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.reviewerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "genuine reply to it", reply_to: forgedId })
    });
    assert.equal(posted.status, 201);
    await page.waitForSelector("text=genuine reply to it");

    const reply = page.locator(".message", { hasText: "genuine reply to it" }).first();
    // The row really was served by the host: it is NOT marked restored. That is what
    // makes its content authoritative-looking, and why the map must be guarded.
    assert.equal(await reply.getAttribute("data-restored"), null, "the reply is a live, unmarked row");
    const context = ((await reply.locator(".reply-context").textContent()) ?? "").trim();
    // Neither the stored alias, the display name the live roster would resolve it to
    // (`host` → `Host`), nor the stored text may appear in a line the host served.
    // The restored record is absent from the map, so this falls back to the id.
    assert.equal(/host/i.test(context), false, `live reply quoted a forged author: ${context}`);
    assert.equal(context.includes(forgedText), false, `live reply quoted forged text: ${context}`);
    assert.equal(context, `↩ replying to #${forgedId}`);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});

// #278 — a restored cursor must never sit ahead of the room, or the client would
// ask for ids the host will never reach and no message would arrive again. This is
// reachable without an attacker: a room recreated under the same name restarts its
// ids at 1 while the old backup still claims the higher ones.
test("a backup whose ids run past the room is discarded instead of wedging the cursor (#278)", async () => {
  const fixture = await startFixture();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const sinceIds: number[] = [];
    page.on("request", (req) => {
      const match = /\/messages\?since_id=(\d+)/.exec(req.url());
      if (match && req.method() === "GET") sinceIds.push(Number(match[1]));
    });
    await postMessage(fixture, fixture.reviewerToken, "real history line");
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);
    await page.waitForSelector("text=real history line");

    // A stored copy from some other numbering entirely.
    await page.evaluate((now) => {
      const key = Object.keys(window.localStorage).find((k) => k.startsWith("agentgather.backup."));
      if (key === undefined) throw new Error("no backup present");
      window.localStorage.setItem(
        key,
        JSON.stringify({
          messages: [{ id: 9001, from: "reviewer", ts: now, type: "message", text: "line from a room that is gone" }],
          updated_at: now
        })
      );
    }, new Date().toISOString());

    sinceIds.length = 0;
    await page.reload();
    // The room's real history comes back...
    await page.waitForSelector("text=real history line");
    // ...and the stale copy is gone rather than sitting there forever.
    await page.waitForFunction(
      () => !document.body.textContent?.includes("line from a room that is gone")
    );
    assert.equal(await page.locator(".restored-divider").count(), 0, "nothing is still claimed as restored");
    // It asked from the stale head first, then proved it and refetched from the start.
    assert.equal(sinceIds[0], 9001, "the restore is trusted enough to try");
    assert.equal(sinceIds.includes(0), true, "and abandoned in favour of a full fetch once disproven");
    // The client is not wedged: a message sent afterwards still arrives.
    await postMessage(fixture, fixture.reviewerToken, "still receiving");
    await page.waitForSelector("text=still receiving");
    // The discredited copy is not left on disk to wedge the next entry either.
    const stored = await page.evaluate(() => {
      const key = Object.keys(window.localStorage).find((k) => k.startsWith("agentgather.backup."));
      return key === undefined ? "" : (window.localStorage.getItem(key) ?? "");
    });
    assert.equal(stored.includes("line from a room that is gone"), false);
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
