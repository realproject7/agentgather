import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { VERSION } from "../src/cli/help.js";
import type { Participant } from "../src/protocol/index.js";
import { createPlatformHttpServer, createControlPlaneRoom } from "../src/platform/index.js";
import { appendServerMessage, createRoom, recordJoinedRoom, writeParticipants } from "../src/storage/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
import { writeToken } from "../src/cli/state.js";
import type { Server } from "node:http";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-browser-platform-test-"));
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function participant(alias: string, kind: Participant["kind"], isHost: boolean, token: string): Participant {
  return {
    alias,
    kind,
    location: "local",
    install: "lite",
    attention: "attending",
    is_host: isHost,
    token_hash: participantTokenHash(token),
    joinedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
}

function roomInput(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    title: "A Room",
    owner_user_id: "owner-1",
    route_url: "https://rooms.agentgather.dev/room",
    status: "active",
    roster: [{ alias: "host", kind: "human", role: "host", status: "attending" }],
    route_health: { reachable: true, host_connected: true },
    last_synced_message_id: 0,
    ...overrides
  };
}

async function listen(server: Server): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const port = await getFreePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

test("build copies platform shell assets into dist", async () => {
  const html = await readFile(new URL("../src/browser/shell.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/browser/shell.css", import.meta.url), "utf8");
  const theme = await readFile(new URL("../src/browser/theme.css", import.meta.url), "utf8");
  const js = await readFile(new URL("../src/browser/shell.js", import.meta.url), "utf8");
  assert.match(html, /shell.css/);
  assert.match(html, /agentgather-logo\.png/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(css, /platform-shell/);
  assert.match(css, /theme\.css/);
  assert.match(theme, /color-scheme: dark/);
  assert.match(theme, /--accent: #ec5c94/);
  assert.match(js, /loadRooms/);
});

test("owner shell renders the room list, status, live chat, and human-vs-agent roster", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(
    root,
    roomInput({
      room_id: "alpha",
      title: "Alpha Room",
      status: "active",
      status_reason: "foreground_attending",
      roster: [
        { alias: "host", kind: "human", role: "host", status: "attending" },
        { alias: "re1", kind: "agent", role: "member", status: "attending" }
      ]
    })
  );
  await createControlPlaneRoom(
    root,
    roomInput({
      room_id: "beta",
      title: "Beta Room",
      status: "paused",
      status_reason: "host_unavailable",
      route_health: { reachable: true, host_connected: false }
    })
  );
  await createRoom({ root, roomId: "alpha", hostAlias: "host", briefBody: "go" });
  await appendServerMessage({ root, roomId: "alpha", from: "system", text: "alpha opened for review" });

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(platform.baseUrl);

    await page.waitForSelector(".room-row");
    await page.waitForSelector("#platform-version-value");
    assert.equal(await page.locator("#platform-version-value").textContent(), `v${VERSION}`);
    assert.equal(await page.locator(".room-row").count(), 2);
    await page.waitForSelector('.room-row[data-status="active"]');
    await page.waitForSelector('.room-row[data-status="paused"]');

    // Selecting the active room shows its status strip, live host messages, and
    // a roster that visually distinguishes human from agent.
    await page.click('.room-row[data-room-id="alpha"]');
    await page.waitForSelector('#detail-status[data-status="active"]');
    await page.waitForSelector("text=alpha opened for review");
    await page.waitForSelector('.roster-entry[data-kind="human"]');
    await page.waitForSelector('.roster-entry[data-kind="agent"]');

    // The paused room surfaces a paused status and its reason.
    await page.click('.room-row[data-room-id="beta"]');
    await page.waitForSelector('#detail-status[data-status="paused"]');
    await page.waitForSelector("text=host_unavailable");
    await page.waitForSelector('#route-host[data-on="false"]');

    // Text does not overflow controls at desktop and narrow widths.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const overflow = await page.evaluate(() => {
        const within = (selector: string): boolean => {
          const element = document.querySelector(selector);
          if (element === null) return true;
          return element.scrollWidth <= element.clientWidth + 1;
        };
        return within("#detail-title") && within(".status-badge") && within(".roster-name");
      });
      assert.equal(overflow, true, `content overflowed at width ${width}`);
    }
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("owner shell shows a first-run welcome state when the owner has no rooms", async () => {
  const root = await makeRoot();
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.platform-shell[data-view="empty"]');
    await page.waitForSelector("text=No rooms yet");
    await page.waitForSelector("#welcome-create");
    // The welcome offers templates to start from and never shows a room row.
    assert.equal(await page.locator(".welcome-template").count(), 4);
    assert.equal(await page.locator(".room-row").count(), 0);
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("populated room list renders v5 rows with monogram, subtitle, age, and a status legend", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(
    root,
    roomInput({
      room_id: "h402-review",
      title: "h402-review",
      status: "active",
      roster: [
        { alias: "host", kind: "human", role: "host", status: "attending" },
        { alias: "seb-agent", kind: "agent", role: "member", status: "attending" }
      ]
    })
  );
  await createControlPlaneRoom(
    root,
    roomInput({ room_id: "launch-copy", title: "launch-copy", status: "closed" })
  );

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.platform-shell[data-view="rooms"]');

    // Rich row: monogram, roster-derived subtitle, relative age, action verb.
    const active = page.locator('.room-row[data-room-id="h402-review"]');
    assert.equal((await active.locator(".room-ic").textContent())?.trim(), "h4");
    assert.match((await active.locator(".room-sub").textContent()) ?? "", /1 human · 1 agent · 2 attending/);
    assert.match((await active.locator(".room-act").textContent()) ?? "", /open/);

    // A closed room dims, summarizes honestly, and offers export.
    const closed = page.locator('.room-row[data-room-id="launch-copy"]');
    assert.match((await closed.locator(".room-sub").textContent()) ?? "", /exported summary available/);
    assert.match((await closed.locator(".room-act").textContent()) ?? "", /export/);

    // The status legend explains all four platform statuses.
    await page.waitForSelector(".status-legend");
    assert.equal(await page.locator('.legend-list .status-badge').count(), 4);
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("create-room shell composes the host CLI command and keeps submit disabled", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "alpha", title: "Alpha", status: "active" }));
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.platform-shell[data-view="rooms"]');

    await page.click("#new-room");
    await page.waitForSelector("#create-overlay:not([hidden])");

    // The composed command reflects the typed name and chosen attendance policy.
    await page.fill("#create-name", "h402 review");
    await page.click('.seg[data-policy="all-foreground"]');
    await page.fill("#create-goal", 'check the "rounding" edge case');
    const command = (await page.locator("#create-command").textContent()) ?? "";
    assert.match(command, /agentgather room start h402-review --attendance all-foreground/);
    // The goal is single-quoted so it stays copy-pasteable and literal.
    assert.match(command, /--brief 'check the "rounding" edge case'/);

    // No fake API: the create button is disabled and creation is via the CLI.
    assert.equal(await page.locator(".primary-btn[disabled]").count(), 1);
    await page.waitForSelector("text=Creating a room from the browser isn't available yet");
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("create-room command shell-quotes the goal so nothing expands on paste", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "alpha", title: "Alpha", status: "active" }));
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.platform-shell[data-view="rooms"]');
    await page.click("#new-room");
    await page.waitForSelector("#create-overlay:not([hidden])");

    // A goal full of shell metacharacters must be wrapped in a single-quoted
    // string with embedded single quotes escaped as '\'' — so $(...), backticks,
    // $VAR, and backslashes are inert literal text when pasted.
    await page.fill("#create-goal", "pwn $(whoami) `id` $HOME \\ it's");
    const command = (await page.locator("#create-command").textContent()) ?? "";
    assert.ok(
      command.includes("--brief 'pwn $(whoami) `id` $HOME \\ it'\\''s'"),
      `command did not safely single-quote the goal: ${command}`
    );
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("invite cards split human (browser-first) and agent (command + safety) without tokens", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(
    root,
    roomInput({
      room_id: "h402-review",
      title: "h402-review",
      route_url: "https://rooms.agentgather.dev/h402-review",
      status: "active",
      roster: [
        { alias: "project7", kind: "human", role: "host", status: "attending" },
        { alias: "seb-agent", kind: "agent", role: "member", status: "attending" }
      ]
    })
  );
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.platform-shell[data-view="rooms"]');
    await page.click('.room-row[data-room-id="h402-review"]');
    await page.click("#invite-button");
    await page.waitForSelector("#invite-overlay:not([hidden])");

    const agent = page.locator('.invite-card[data-kind="agent"]');
    const human = page.locator('.invite-card[data-kind="human"]');
    assert.equal(await agent.count(), 1);
    assert.equal(await human.count(), 1);

    // Human card is browser-first: its primary action opens the room in a browser.
    await human.locator(".join-btn", { hasText: "Open room in browser" }).waitFor();
    assert.equal(await human.locator(".card-cmd").count(), 0);

    // Agent card is command + safety first, with the exact attend/read/send guidance.
    await agent.locator(".card-safety", { hasText: "not operator authority" }).waitFor();
    const agentCmd = (await agent.locator(".card-cmd").textContent()) ?? "";
    assert.match(agentCmd, /agentgather attend --json/);
    assert.match(agentCmd, /\/messages\?since_id=0/);
    assert.match(agentCmd, /-X POST/);

    // Room name and participant display name are kept distinct (#97).
    await agent.locator(".card-field", { hasText: "room name" }).waitFor();
    await agent.locator(".card-field", { hasText: "display name" }).waitFor();

    // No real tokens are ever shown — only the literal $TOKEN variable.
    const overlayText = (await page.locator("#invite-overlay").textContent()) ?? "";
    assert.match(overlayText, /\$TOKEN/);
    assert.doesNotMatch(overlayText, /tgl_/);
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("history source shows the live host room and caches messages browser-locally", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "live-room", status: "active" }));
  await createRoom({ root, roomId: "live-room", hostAlias: "host", briefBody: "go" });
  await appendServerMessage({ root, roomId: "live-room", from: "system", text: "live history line" });

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const methods: string[] = [];
    page.on("request", (req) => methods.push(req.method()));
    await page.goto(platform.baseUrl);
    await page.click('.room-row[data-room-id="live-room"]');

    await page.waitForSelector('#history-source[data-source="live"]');
    await page.waitForSelector("text=History: live host room");
    await page.waitForSelector("text=live history line");

    // The cache is browser-local (localStorage), per-room-scoped, and carries no
    // bearer token or invite URL.
    const cached = await page.evaluate(() => window.localStorage.getItem("agentgather.history.live-room"));
    assert.notEqual(cached, null);
    assert.match(cached ?? "", /live history line/);
    assert.doesNotMatch(cached ?? "", /Bearer|tgl_|token/);

    // The shell never uploads message bodies: every request is a read (GET).
    assert.equal(methods.every((method) => method === "GET"), true, `non-GET requests: ${methods.join(",")}`);
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("cached message bodies redact bearer tokens and invite/card URLs in localStorage", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "secret-room", status: "active" }));
  await createRoom({ root, roomId: "secret-room", hostAlias: "host", briefBody: "go" });
  const secretLine =
    "join https://rooms.agentgather.dev/secret-room/card?participant=re1#token=tgl_SUPERSECRET via Authorization: Bearer tgl_SUPERSECRET";
  await appendServerMessage({ root, roomId: "secret-room", from: "host", text: secretLine });

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(platform.baseUrl);
    await page.click('.room-row[data-room-id="secret-room"]');
    await page.waitForSelector('#history-source[data-source="live"]');
    // Live rendering stays faithful: the full token-bearing line is visible.
    await page.waitForSelector("text=tgl_SUPERSECRET");

    // The persisted cache copy redacts the whole invite/card URL and every
    // token/credential form — not just the raw token value.
    const cached = (await page.evaluate(() => window.localStorage.getItem("agentgather.history.secret-room"))) ?? "";
    for (const banned of [/tgl_/, /Bearer/, /#token=/, /token=/, /SUPERSECRET/, /rooms\.agentgather\.dev/, /\/card/, /participant=/]) {
      assert.doesNotMatch(cached, banned);
    }
    // The redaction marker is present, proving the body was cached but sanitized.
    assert.match(cached, /redacted/);
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("a live host replaces the redacted cache seed with the faithful message", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "faithful-room", status: "active" }));
  await createRoom({ root, roomId: "faithful-room", hostAlias: "host", briefBody: "go" });
  await appendServerMessage({ root, roomId: "faithful-room", from: "host", text: "live secret tgl_LIVE_FAITHFUL" });

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    // Pre-seed a REDACTED cache copy for the same message id the host returns.
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "agentgather.history.faithful-room",
        JSON.stringify({
          messages: [{ id: 1, from: "host", ts: "2026-06-23T00:00:00.000Z", type: "message", text: "live secret [redacted-token]" }],
          updated_at: "2026-06-23T00:00:00.000Z"
        })
      );
    });
    await page.goto(platform.baseUrl);
    await page.click('.room-row[data-room-id="faithful-room"]');
    await page.waitForSelector('#history-source[data-source="live"]');
    // Live rendering stays faithful: the full token-bearing body shows and the
    // redacted provisional cache copy is replaced, not left on screen.
    await page.waitForSelector("text=tgl_LIVE_FAITHFUL");
    assert.equal(await page.locator(".shell-message-text", { hasText: "[redacted-token]" }).count(), 0);
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("history falls back to local cache with #81 paused copy when the host is offline, with no upload", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(
    root,
    roomInput({
      room_id: "paused-room",
      status: "paused",
      status_reason: "host_unavailable",
      route_health: { reachable: true, host_connected: false }
    })
  );

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    // Seed this browser's per-room cache before the shell scripts run.
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "agentgather.history.paused-room",
        JSON.stringify({
          messages: [{ id: 1, from: "host", ts: "2026-06-23T00:00:00.000Z", type: "system", text: "cached offline line" }],
          updated_at: "2026-06-23T00:00:00.000Z"
        })
      );
    });
    const methods: string[] = [];
    page.on("request", (req) => methods.push(req.method()));
    await page.goto(platform.baseUrl);
    await page.click('.room-row[data-room-id="paused-room"]');

    // Cache source, cached message visible, and paused copy driven by #81 status
    // rather than a generic network error.
    await page.waitForSelector('#history-source[data-source="cache"]');
    await page.waitForSelector("text=History: local cache");
    await page.waitForSelector("text=cached offline line");
    await page.waitForSelector("text=host must reopen this room");

    assert.equal(methods.every((method) => method === "GET"), true, `non-GET requests: ${methods.join(",")}`);
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("history shows the exported-summary label when host offline with no cache", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "exported-room", status: "paused", status_reason: "host_unavailable" }));

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.addInitScript(() => {
      window.localStorage.setItem("agentgather.exported.exported-room", "2026-06-23T00:00:00.000Z");
    });
    await page.goto(platform.baseUrl);
    await page.click('.room-row[data-room-id="exported-room"]');
    await page.waitForSelector('#history-source[data-source="exported"]');
    await page.waitForSelector("text=History: exported summary");
    await page.waitForSelector("text=exported summary is saved");
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("a tokened single-room link renders one room without a multi-room list", async () => {
  const root = await makeRoot();
  const roomId = "tokened-room";
  const hostToken = `host-${roomId}`;
  await createRoom({ root, roomId, hostAlias: "host", briefBody: "Single room only." });
  await writeParticipants(root, roomId, [
    { ...participant("host", "human", true, hostToken), display_name: "Host" }
  ]);
  const room = await listen(createRoomHttpServer({ root, roomId, baseUrl: "http://127.0.0.1:0", rateLimitPerMinute: 1_000 }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(`${room.baseUrl}/#token=${hostToken}`);
    await page.waitForSelector("text=Single room only.");
    // The tokened participant view is the single-room shell, never the owner
    // multi-room list.
    assert.equal(await page.locator("#room-list").count(), 0);
    assert.equal(await page.locator(".platform-shell").count(), 0);
    assert.equal(await page.locator(".room-shell").count(), 1);
  } finally {
    await browser.close();
    await room.close();
  }
});

test("the owner shell renders the three history-source states through the platform server (#176)", async () => {
  const root = await makeRoot();
  // alpha: active + a real host log → "live host room".
  await createControlPlaneRoom(root, roomInput({ room_id: "alpha", title: "Alpha", status: "active" }));
  await createRoom({ root, roomId: "alpha", hostAlias: "host", briefBody: "go" });
  await appendServerMessage({ root, roomId: "alpha", from: "system", text: "alpha live line" });
  // beta: registered + active but NO host log → host offline, nothing cached.
  await createControlPlaneRoom(root, roomInput({ room_id: "beta", title: "Beta", status: "active" }));

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector(".room-row");

    // 1) Live from host: the live host log is surfaced.
    await page.click('.room-row[data-room-id="alpha"]');
    await page.waitForSelector('#history-source[data-source="live"]');
    await page.waitForSelector("text=History: live host room");
    await page.waitForSelector("text=alpha live line");

    // 2) Host offline: registered room, host log unavailable, nothing cached.
    await page.click('.room-row[data-room-id="beta"]');
    await page.waitForSelector('#history-source[data-source="empty"]');
    await page.waitForSelector("text=Host is offline");

    // 3) Local snapshot: alpha was cached live; now the host log goes offline, so the
    //    shell falls back to this browser's cached copy.
    await page.route("**/rooms/alpha/messages*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, messages: [], next_since_id: 0, host_log_available: false })
      })
    );
    await page.click('.room-row[data-room-id="alpha"]');
    await page.waitForSelector('#history-source[data-source="cache"]');
    await page.waitForSelector("text=History: local cache (host offline)");
    await page.waitForSelector("text=alpha live line");
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("the dashboard shows device-local joined rooms and clears browser-added ones gracefully (#178)", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "alpha", title: "Alpha", status: "active" }));
  const now = new Date().toISOString();
  // A CLI-recorded joined room (device file), pointing at an unreachable URL.
  await recordJoinedRoom(root, {
    roomId: "joined-cli",
    title: "Joined via CLI",
    alias: "me",
    baseUrl: "http://127.0.0.1:9",
    joinedAt: now,
    lastSeen: now
  });
  await writeToken(root, "joined-cli", "me", "tgl_joined_cli_secret");

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(platform.baseUrl);

    // Same-device round-trip: the CLI-recorded join appears in "Rooms I'm in" with
    // honest (unreachable) reachability.
    await page.waitForSelector('.joined-row[data-reachability="unreachable"]');
    await page.waitForSelector("text=Joined via CLI");

    const cliOpenHref = (await page.locator('.joined-row[data-reachability="unreachable"]').getAttribute("data-open-href")) ?? "";
    assert.match(cliOpenHref, /\/joined-rooms\/open\?/);
    assert.equal(/tgl_|token=|Bearer/i.test(cliOpenHref), false);

    const openUrl = new URL(`${platform.baseUrl}/joined-rooms/open`);
    openUrl.searchParams.set("room_id", "joined-cli");
    openUrl.searchParams.set("base_url", "http://127.0.0.1:9");
    const redirect = await fetch(openUrl, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get("location") ?? "", /^http:\/\/127\.0\.0\.1:9\/?\?dashboard=.*#token=tgl_joined_cli_secret$/);

    // Add a browser-recorded token-free pointer.
    await page.fill("#joined-input", "http://127.0.0.1:8787/saved-room");
    await page.click("#joined-add-button");
    await page.waitForSelector('.joined-row[data-reachability="saved"]');

    // The token was stripped: localStorage holds metadata only, never the secret.
    const stored = await page.evaluate(() => window.localStorage.getItem("agentgather.joinedRooms"));
    assert.ok(stored);
    assert.equal(/tgl_|token=|Bearer/i.test(stored || ""), false);

    const savedOpenHref = (await page.locator('.joined-row[data-reachability="saved"]').getAttribute("data-open-href")) ?? "";
    assert.match(savedOpenHref, /\/joined-rooms\/open\?/);
    assert.equal(/tgl_|token=|Bearer/i.test(savedOpenHref), false);

    await page.click('.joined-row[data-reachability="saved"] .joined-forget');

    // Clearing browser storage drops the browser-added entry gracefully; the CLI
    // record (device file, not browser storage) is unaffected.
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await page.waitForSelector("text=Joined via CLI");
    assert.equal(await page.locator('.joined-row[data-reachability="saved"]').count(), 0);
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("the dashboard remembers tokenized root invite links as real joined rooms", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "alpha", title: "Alpha", status: "active" }));
  const inviteToken = "tgl_invite_root_secret";
  await createRoom({ root, roomId: "remember-room", hostAlias: "host", briefBody: "Remember root invite." });
  await writeParticipants(root, "remember-room", [
    participant("host", "agent", true, "host-token"),
    { ...participant("project7", "human", false, inviteToken), display_name: "project7" }
  ]);
  const roomEntry = await listen(createRoomHttpServer({ root, roomId: "remember-room", baseUrl: "http://127.0.0.1:0", rateLimitPerMinute: 1000 }));
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(platform.baseUrl);

    await page.fill("#joined-input", `${roomEntry.baseUrl}/#token=${inviteToken}`);
    await page.click("#joined-add-button");
    await page.waitForSelector('.joined-row[data-reachability="live"]');
    await page.waitForSelector("text=remember-room");

    const stored = await page.evaluate(() => window.localStorage.getItem("agentgather.joinedRooms"));
    assert.equal(/tgl_|token=|Bearer/i.test(stored || ""), false);
    assert.equal(await page.locator('.joined-row[data-reachability="saved"]').count(), 0);

    const api = (await (await fetch(`${platform.baseUrl}/joined-rooms`)).json()) as {
      rooms: Array<{ roomId: string; alias: string; baseUrl: string }>;
    };
    assert.equal(api.rooms.some((room) => room.roomId === "remember-room" && room.alias === "project7"), true);
    assert.equal(/tgl_|Bearer|token=|invite_root_secret/i.test(JSON.stringify(api)), false);

    const openUrl = new URL(`${platform.baseUrl}/joined-rooms/open`);
    openUrl.searchParams.set("room_id", "remember-room");
    openUrl.searchParams.set("base_url", roomEntry.baseUrl);
    const redirect = await fetch(openUrl, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get("location") ?? "", /#token=tgl_invite_root_secret$/);
  } finally {
    await browser.close();
    await platform.close();
    await roomEntry.close();
  }
});

test("the dashboard shows joined rooms even when the user hosts no rooms (#178)", async () => {
  const root = await makeRoot();
  const now = new Date().toISOString();
  await recordJoinedRoom(root, {
    roomId: "joined-only",
    title: "Joined Only",
    alias: "me",
    baseUrl: "http://127.0.0.1:9",
    joinedAt: now,
    lastSeen: now
  });

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(platform.baseUrl);

    await page.waitForSelector("text=Joined Only");
    assert.equal(await page.locator("#welcome").isVisible(), false);
    assert.equal(await page.locator(".platform-body").isVisible(), true);
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("a browser room join bridges into the owner dashboard's 'Rooms I'm in' token-free (#178)", async () => {
  const root = await makeRoot();
  // A hosted room keeps the dashboard in its populated (non-welcome) view.
  await createControlPlaneRoom(root, roomInput({ room_id: "alpha", title: "Alpha", status: "active" }));

  // The actual room the user joins in the browser, with a real host log.
  const hostToken = "host-bridge-tok";
  await createRoom({ root, roomId: "bridge-room", hostAlias: "host", briefBody: "Bridge test brief." });
  await writeParticipants(root, "bridge-room", [
    { ...participant("host", "human", true, hostToken), display_name: "Host" }
  ]);
  const roomEntry = await listen(createRoomHttpServer({ root, roomId: "bridge-room", baseUrl: "http://127.0.0.1:0", rateLimitPerMinute: 1000 }));
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));

  const browser = await chromium.launch();
  try {
    // Open the tokenized invite in the browser, carrying this dashboard's origin.
    const roomPage = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await roomPage.goto(`${roomEntry.baseUrl}/?dashboard=${encodeURIComponent(platform.baseUrl)}#token=${hostToken}`);
    await roomPage.waitForSelector("text=Bridge test brief.");

    // The join bridged token-free metadata to the platform; the dashboard lists it.
    const dashPage = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await dashPage.goto(platform.baseUrl);
    await dashPage.waitForFunction(
      () => [...document.querySelectorAll("#joined-list .joined-name")].some((n) => (n.textContent || "").includes("bridge-room")),
      { timeout: 15000 }
    );

    // The bridged record carries no token (not the value, not a #token=/tgl_/Bearer form).
    const api = (await (await fetch(`${platform.baseUrl}/joined-rooms`)).json()) as {
      rooms: Array<{ roomId: string; baseUrl: string }>;
    };
    assert.equal(api.rooms.some((room) => room.roomId === "bridge-room"), true);
    assert.equal(/tgl_|Bearer|token=|host-bridge-tok/i.test(JSON.stringify(api)), false);
    assert.equal(api.rooms.find((room) => room.roomId === "bridge-room")?.baseUrl, roomEntry.baseUrl);
  } finally {
    await browser.close();
    await platform.close();
    await roomEntry.close();
  }
});

// #218a / #221 — unified workspace shell: dashboard-home and selected-room states
// render in one shell; the permanent top-left logo returns to dashboard home; the
// lower rail swaps Room Status guidance for the selected room's channel nav.
test("the unified shell swaps home guidance for the selected room's channel nav and returns via logo-home (#218a)", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(
    root,
    roomInput({ room_id: "alpha", title: "Alpha Room", status: "active" })
  );
  await createRoom({ root, roomId: "alpha", hostAlias: "host", briefBody: "go" });
  const now = new Date().toISOString();
  await recordJoinedRoom(root, {
    roomId: "joined-only",
    title: "Joined Only",
    alias: "me",
    baseUrl: "http://127.0.0.1:9",
    joinedAt: now,
    lastSeen: now
  });

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.platform-shell[data-view="rooms"]');

    // Dashboard-home (no room selected): the top rail lists hosted + joined rooms,
    // the lower rail shows Room Status guidance, and there is no breadcrumb.
    await page.waitForSelector(".room-row");
    await page.waitForSelector("text=Joined Only"); // joined room present in the top region
    assert.equal(await page.locator("#lower-home").isVisible(), true);
    assert.equal(await page.locator("#lower-room").isHidden(), true);
    assert.equal(await page.locator("#lower-home .guide").isVisible(), true);
    assert.equal((await page.locator("#crumb").textContent())?.trim(), "");
    assert.equal(await page.locator("#detail-empty").isVisible(), true);
    assert.equal(await page.locator("#detail").isHidden(), true);

    // Selecting a room does NOT swap the page shell: same rail, same grid — only
    // the lower region swaps to the channel nav and the breadcrumb names the room.
    await page.click('.room-row[data-room-id="alpha"]');
    await page.waitForSelector("#lower-room:not([hidden])");
    assert.equal(await page.locator("#lower-home").isHidden(), true);
    assert.equal(await page.locator("#detail").isVisible(), true);
    // Channel nav shows the one channel every room has — #general chat — selected.
    assert.equal(await page.locator("#channel-nav .channel-row").count(), 1);
    assert.equal((await page.locator("#channel-nav .channel-name").textContent())?.trim(), "general");
    assert.equal((await page.locator("#channel-nav .channel-type").textContent())?.trim(), "chat");
    await page.waitForSelector("#channel-nav .channel-row.on");
    assert.equal((await page.locator("#crumb").textContent())?.trim(), "/ Alpha Room / #general");

    // The permanent top-left logo returns to dashboard home from the room state.
    await page.click("#brand-home");
    await page.waitForSelector("#lower-home:not([hidden])");
    assert.equal(await page.locator("#lower-room").isHidden(), true);
    assert.equal(await page.locator("#detail").isHidden(), true);
    assert.equal(await page.locator("#detail-empty").isVisible(), true);
    assert.equal((await page.locator("#crumb").textContent())?.trim(), "");
    assert.equal(await page.locator(".room-row[aria-current='true']").count(), 0);

    // No raw token appears in the rail lists or in any navigation href.
    const railHtml = (await page.locator(".room-rail").innerHTML()) ?? "";
    assert.equal(/tgl_|token=|Bearer/i.test(railHtml), false);
    const openHrefs = await page.locator(".joined-row").evaluateAll((rows) =>
      rows.map((row) => (row as HTMLElement).dataset.openHref ?? "")
    );
    assert.equal(openHrefs.some((href) => /tgl_|token=|Bearer/i.test(href)), false);
  } finally {
    await browser.close();
    await platform.close();
  }
});

// #218a / #221 — long room lists collapse behind a stable show-more/show-less
// control (no layout jump) and long titles ellipsize without blowing out the grid.
test("the room rail collapses a long list behind a stable overflow control and ellipsizes long titles (#218a)", async () => {
  const root = await makeRoot();
  const longTitle = "release-checklist-room-with-an-extremely-long-title-that-must-ellipsize-in-the-rail";
  for (let i = 0; i < 9; i++) {
    await createControlPlaneRoom(
      root,
      roomInput({ room_id: `room-${i}`, title: i === 0 ? longTitle : `room-${i}`, status: "active" })
    );
  }

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.platform-shell[data-view="rooms"]');
    await page.waitForSelector("#rooms-more:not([hidden])");

    // 9 rooms, budget 6 → 3 collapsed behind the control; only 6 rows are visible.
    assert.equal(await page.locator(".room-list > li").count(), 9);
    assert.equal(await page.locator(".room-list > li:not(.is-collapsed)").count(), 6);
    assert.match((await page.locator("#rooms-more").textContent()) ?? "", /show 3 more/);

    // Expand → all rows visible, control flips to "show less"; collapse → back to 6.
    // The control keeps a stable single-row height, so neither shift jumps layout.
    const barBefore = await page.locator("#rooms-more").boundingBox();
    await page.click("#rooms-more");
    assert.equal(await page.locator(".room-list > li:not(.is-collapsed)").count(), 9);
    assert.match((await page.locator("#rooms-more").textContent()) ?? "", /show less/);
    const barAfter = await page.locator("#rooms-more").boundingBox();
    assert.equal(Math.round(barBefore?.height ?? 0), Math.round(barAfter?.height ?? -1));
    await page.click("#rooms-more");
    assert.equal(await page.locator(".room-list > li:not(.is-collapsed)").count(), 6);

    // The long title ellipsizes: its name element is truncated (scrollWidth wider
    // than its box) and never overflows the fixed-width rail track.
    const truncation = await page.evaluate(() => {
      const name = document.querySelector('.room-row[data-room-id="room-0"] .room-name') as HTMLElement | null;
      const rail = document.querySelector(".room-rail") as HTMLElement | null;
      if (name === null || rail === null) return { ellipsized: false, contained: false };
      const style = getComputedStyle(name);
      return {
        ellipsized: style.textOverflow === "ellipsis" && name.scrollWidth > name.clientWidth,
        contained: rail.scrollWidth <= rail.clientWidth + 1
      };
    });
    assert.equal(truncation.ellipsized, true, "long room title did not ellipsize");
    assert.equal(truncation.contained, true, "long title overflowed the rail track");
  } finally {
    await browser.close();
    await platform.close();
  }
});

// #218b — the selected-room state becomes a three-panel workspace with a right
// info panel that fills the column height and scrolls independently; the home /
// no-room state must NOT render it (the [hidden] override beats display:flex),
// and it collapses at narrow width.
test("the dashboard mounts a right info panel in the three-panel state, hides it at home and narrow width, and scrolls instead of clipping (#218b)", async () => {
  const root = await makeRoot();
  const roster: Array<Record<string, unknown>> = [{ alias: "host", kind: "human", role: "host", status: "attending" }];
  for (let i = 0; i < 30; i++) roster.push({ alias: `member-${i}`, kind: "agent", role: "member", status: "attending" });
  await createControlPlaneRoom(root, roomInput({ room_id: "alpha", title: "Alpha Room", status: "active", roster }));
  await createRoom({ root, roomId: "alpha", hostAlias: "host", briefBody: "go" });

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.platform-shell[data-view="rooms"]');

    // No-room state: the right info panel must be display:none — the explicit
    // display:flex would otherwise leak it into home (the [hidden] gotcha).
    assert.equal(await page.locator("#info-panel").isHidden(), true);
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.getElementById("info-panel")!).display),
      "none"
    );
    assert.equal(
      await page.evaluate(() => document.querySelector(".platform-shell")!.classList.contains("room-selected")),
      false
    );

    // Select the room → three-panel: shell gains .room-selected, the body grid has
    // three tracks, and the info panel shows the room summary + participants.
    await page.click('.room-row[data-room-id="alpha"]');
    await page.waitForSelector("#info-panel:not([hidden])");
    assert.equal(
      await page.evaluate(() => document.querySelector(".platform-shell")!.classList.contains("room-selected")),
      true
    );
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.querySelector(".platform-body")!).gridTemplateColumns.split(" ").length),
      3
    );
    assert.equal((await page.locator("#info-room-name").textContent())?.trim(), "Alpha Room");
    await page.waitForSelector("#shell-roster .roster-entry");

    // Clipping fix: the roster overflows, the single .info-scroll child is the
    // scroll context, and the panel bottom stays within the viewport (no clip).
    const scroll = await page.evaluate(() => {
      const s = document.querySelector("#info-panel .info-scroll") as HTMLElement;
      const panel = document.getElementById("info-panel")!;
      return {
        overflowing: s.scrollHeight > s.clientHeight,
        overflowY: getComputedStyle(s).overflowY,
        // The outer .info panel must NOT scroll — .info-scroll is the sole boundary.
        outerScrolls: panel.scrollHeight > panel.clientHeight + 1,
        withinViewport: panel.getBoundingClientRect().bottom <= window.innerHeight + 1
      };
    });
    assert.equal(scroll.overflowing, true, "info panel did not overflow with 31 participants");
    assert.equal(scroll.overflowY, "auto");
    assert.equal(scroll.outerScrolls, false, "the outer info panel is still a scroll boundary");
    assert.equal(scroll.withinViewport, true, "info panel clipped past the viewport bottom");

    // No raw token in the panel or the breadcrumb.
    const panelHtml = (await page.locator("#info-panel").innerHTML()) ?? "";
    assert.equal(/tgl_|token=|Bearer/i.test(panelHtml), false);
    assert.equal(/tgl_|token=/i.test((await page.locator("#crumb").textContent()) ?? ""), false);

    // Narrow width hides the right panel even in the room state (spec).
    await page.setViewportSize({ width: 820, height: 760 });
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.getElementById("info-panel")!).display),
      "none"
    );

    // Logo-home returns to no-room → panel display:none again.
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.click("#brand-home");
    await page.locator("#info-panel").waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.getElementById("info-panel")!).display),
      "none"
    );
  } finally {
    await browser.close();
    await platform.close();
  }
});
