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
  const js = await readFile(new URL("../src/browser/room.js", import.meta.url), "utf8");
  assert.match(html, /room.css/);
  assert.match(css, /room-shell/);
  assert.match(css, /color-scheme: dark/);
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
    await page.waitForSelector("text=agent · local · lite · away");

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
    await page.waitForSelector("text=agent · local · lite · stale");

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
    await page.fill("#message-text", "@gpt typo mention");
    await page.click("#send-button");
    await page.waitForSelector("text=@gpt not in this room; not delivered as a mention.");
    await page.waitForSelector("text=@gpt typo mention");
    await page.fill("#message-text", "@reviewer second send");
    await page.click("#send-button");
    await page.waitForSelector("text=rate limit exceeded");
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
