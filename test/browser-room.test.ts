import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import type { Participant } from "../src/protocol/index.js";
import { createRoom, writeParticipants } from "../src/storage/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";

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
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  };
}

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
    await page.waitForSelector("text=Ship the browser room safely.");

    const humanToken = `guest-${fixture.roomId}`;
    await writeParticipants(fixture.root, fixture.roomId, [
      { ...participant("host", "human", true, fixture.hostToken), display_name: "Host" },
      participant("reviewer", "agent", false, fixture.reviewerToken),
      participant("guest", "human", false, humanToken)
    ]);

    const guestPage = await browser.newPage({ viewport: { width: 960, height: 700 } });
    await guestPage.goto(`${fixture.baseUrl}/#token=${humanToken}`);
    await guestPage.waitForSelector("text=Choose your room name");
    await guestPage.fill("#display-name", "Project Seven");
    await guestPage.click("#join-button");
    await guestPage.waitForSelector("text=Ship the browser room safely.");
    await guestPage.waitForSelector("text=Project Seven");
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

test("route failures show a degraded reconnecting banner and recover to live", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);
    await page.waitForSelector("text=Ship the browser room safely.");

    // Simulate the broker reporting the host tunnel as unavailable on later polls.
    await page.route(/\/(messages|status)(\?|$)/, (route) =>
      route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "host_unavailable", message: "host tunnel did not respond" })
      })
    );
    await page.waitForSelector('#room-banner[data-kind="degraded"]');
    await page.waitForSelector("text=Reconnecting…");
    await page.waitForSelector("text=host_unavailable");

    // When the route recovers, the banner clears on the next successful poll.
    await page.unroute(/\/(messages|status)(\?|$)/);
    await page.waitForSelector("#room-banner", { state: "hidden" });
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

    // #116 — host sees the control section; idle/pause are disabled (platform-managed),
    // tickets is disabled (no fabricated data), and the state segment shows "active".
    assert.equal(await page.isHidden("#host-controls"), false);
    assert.ok(await page.getAttribute("#rs-active", "class").then((c) => (c || "").includes("on")));
    assert.equal(await page.$$eval(".rail-state .rs[data-disabled='true']", (e) => e.length), 2);
    assert.equal(await page.isDisabled("#tickets-button"), true);
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
