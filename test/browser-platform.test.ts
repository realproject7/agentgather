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
import {
  appendServerMessage,
  createRoom,
  recordJoinedHistory,
  recordJoinedRoom,
  writeParticipants
} from "../src/storage/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
import { writeToken } from "../src/cli/state.js";
import type { Server } from "node:http";
import { closeServer } from "./support/close-server.js";

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
  return listenOn(server, await getFreePort());
}

// Bind a chosen port — needed when a room has to come back on the SAME base URL a
// joined-room row already points at (#247 live recovery).
async function listenOn(server: Server, port: number): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => closeServer(server)
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
    await page.waitForSelector(".welcome-title");
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

    // #279 — the band saying "local cache" is not enough: the ROWS are this
    // browser's own localStorage copy and are editable by anything with script
    // access to this origin, so they carry the same fixed attribution as a saved
    // snapshot row rather than a stored alias.
    const cachedRow = page.locator(".shell-message", { hasText: "alpha live line" }).first();
    assert.equal(await cachedRow.getAttribute("data-restored"), "true");
    assert.equal((await cachedRow.locator(".shell-message-from").textContent())?.trim(), "local copy");

    // A hand-edited cache cannot speak in the room's own voice either.
    await page.evaluate(() => {
      const raw = window.localStorage.getItem("agentgather.history.alpha");
      const parsed = raw ? JSON.parse(raw) : { messages: [] };
      parsed.messages.push({ id: 9001, from: "host", ts: new Date().toISOString(), type: "system", text: "cached system forgery" });
      window.localStorage.setItem("agentgather.history.alpha", JSON.stringify(parsed));
    });
    await page.click('.room-row[data-room-id="beta"]');
    await page.click('.room-row[data-room-id="alpha"]');
    await page.waitForSelector("text=cached system forgery");
    // The forged line's TEXT is shown — dropping it would also drop the room's
    // genuine announcements, which are `system` too — but it is de-voiced: no
    // system styling, and attributed to this device rather than to the room.
    const forgedCache = page.locator(".shell-message", { hasText: "cached system forgery" }).first();
    assert.equal(await forgedCache.getAttribute("data-restored"), "true");
    assert.equal((await forgedCache.locator(".shell-message-from").textContent())?.trim(), "local copy");
    assert.equal(await page.locator(".shell-message.system").count(), 0, "nothing wears the room's own voice");
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
    assert.match(redirect.headers.get("location") ?? "", /^http:\/\/127\.0\.0\.1:9\/?\?dashboard=.*#token=tgl_joined_cli_secret(&snapshot=[A-Za-z0-9_-]+)?$/);

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

    // Delete the browser-added entry via the device-local delete control — an
    // inline confirm (never a native dialog), then confirm.
    await page.click('.joined-row[data-reachability="saved"] .joined-ctl-danger');
    await page.click('.joined-row[data-reachability="saved"] [data-action="confirm-delete"]');

    // The browser-added entry is dropped; the CLI record (device file, not browser
    // storage) is unaffected.
    await page.waitForSelector("text=Joined via CLI");
    await page.waitForFunction(
      () => document.querySelectorAll('.joined-row[data-reachability="saved"]').length === 0
    );
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
    assert.match(redirect.headers.get("location") ?? "", /#token=tgl_invite_root_secret(&snapshot=[A-Za-z0-9_-]+)?$/);
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
      () => [...document.querySelectorAll("#room-list .joined-name")].some((n) => (n.textContent || "").includes("bridge-room")),
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

// #216 — the dashboard shows the human-readable display title as the primary
// "Rooms I'm in" label, with the slug-like room id demoted to secondary/tooltip;
// a room with no known title falls back cleanly to the id; long titles ellipsize.
test("the dashboard labels joined rooms by display title, not slug, with the id as secondary/debug metadata (#216)", async () => {
  const root = await makeRoot();
  const now = new Date().toISOString();
  // A joined room with a real display title (hydrated at join time).
  await recordJoinedRoom(root, {
    roomId: "ag-project-0706",
    title: "Agent Gather Launch",
    alias: "me",
    baseUrl: "http://127.0.0.1:9",
    joinedAt: now,
    lastSeen: now
  });
  // A joined room whose title is only the slug (no display name known).
  await recordJoinedRoom(root, {
    roomId: "release-checklist-with-a-very-long-slug-that-should-ellipsize-in-the-rail",
    title: "release-checklist-with-a-very-long-slug-that-should-ellipsize-in-the-rail",
    alias: "me",
    baseUrl: "http://127.0.0.1:8",
    joinedAt: now,
    lastSeen: now
  });

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector(".joined-row");

    // Titled room: primary label is the display title, NOT the slug.
    const titled = page.locator('.joined-row:has(.joined-name:text-is("Agent Gather Launch"))');
    assert.equal(await titled.count(), 1);
    assert.equal(await titled.locator(".joined-main").getAttribute("data-titled"), "true");
    // The room id is available as secondary/debug metadata (sub line + tooltip).
    assert.match((await titled.locator(".joined-sub").textContent()) ?? "", /ag-project-0706/);
    assert.match((await titled.locator(".joined-name").getAttribute("title")) ?? "", /room id: ag-project-0706/);

    // Untitled room: falls back to the slug as the primary label, flagged as a fallback.
    const fallback = page.locator('.joined-row:has(.joined-main[data-titled="false"])');
    assert.equal(await fallback.count(), 1);
    assert.match((await fallback.locator(".joined-name").textContent()) ?? "", /^release-checklist-/);

    // No raw token anywhere in the rendered rail or the token-free joined-rooms API.
    const railHtml = (await page.locator(".room-rail").innerHTML()) ?? "";
    assert.equal(/tgl_|token=|Bearer/i.test(railHtml), false);
    const api = await (await fetch(`${platform.baseUrl}/joined-rooms`)).json();
    assert.equal(/tgl_|token=|Bearer/i.test(JSON.stringify(api)), false);

    // The long fallback slug ellipsizes and does not overflow the rail track.
    const contained = await page.evaluate(() => {
      const name = document.querySelector('.joined-main[data-titled="false"] .joined-name') as HTMLElement | null;
      const rail = document.querySelector(".room-rail") as HTMLElement | null;
      if (name === null || rail === null) return false;
      return getComputedStyle(name).textOverflow === "ellipsis" && rail.scrollWidth <= rail.clientWidth + 1;
    });
    assert.equal(contained, true, "long joined-room slug overflowed the rail");
  } finally {
    await browser.close();
    await platform.close();
  }
});

// #213 — the first-run empty state is a polished, product-like screen: onboarding
// copy + strong first action + "what happens" steps + a consistent template-card
// grid with distinct symbols, with no overflow at 1440 / 1280 / 390.
test("the first-run empty state is a polished, responsive product screen (#213)", async () => {
  const root = await makeRoot();
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.platform-shell[data-view="empty"]');
    await page.waitForSelector(".welcome-template");

    // Onboarding: a real headline, a keyboard-accessible primary CTA, and a
    // 3-step "what happens when you create a room" explanation.
    assert.notEqual(((await page.locator(".welcome-title").textContent()) ?? "").trim(), "");
    assert.equal(await page.locator("#welcome-create").evaluate((el) => el.tagName), "BUTTON");
    assert.equal(await page.locator(".welcome-steps li").count(), 3);

    // Four template cards, each a real (keyboard-accessible) button with a DISTINCT
    // symbol — not the old identical diamond.
    const cards = page.locator(".welcome-template");
    assert.equal(await cards.count(), 4);
    assert.equal(await cards.evaluateAll((els) => els.every((e) => e.tagName === "BUTTON")), true);
    const glyphs = await page
      .locator(".welcome-template .tpl-ic")
      .evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
    assert.equal(new Set(glyphs).size, 4, "template icons are not distinct");

    // Card radius <= 8px (design constraint).
    const radius = await cards.first().evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
    assert.ok(radius <= 8, `card radius ${radius}px exceeds 8px`);

    // Polished, no overflow at 1440 / 1280 / 390: nothing overflows its box and the
    // page never scrolls horizontally.
    for (const width of [1440, 1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const ok = await page.evaluate(() => {
        const within = (sel: string): boolean =>
          [...document.querySelectorAll(sel)].every((e) => (e as HTMLElement).scrollWidth <= (e as HTMLElement).clientWidth + 1);
        const noHScroll = document.documentElement.scrollWidth <= window.innerWidth + 1;
        return (
          within(".welcome-title") &&
          within(".welcome-cta") &&
          within(".welcome-template") &&
          within(".tpl-name") &&
          within(".tpl-desc") &&
          noHScroll
        );
      });
      assert.equal(ok, true, `empty state overflowed at width ${width}`);
    }
  } finally {
    await browser.close();
    await platform.close();
  }
});

// #214 — dashboard templates are real presets: each prefills a distinct Room Brief
// and distinct default channels and composes the create-boardroom command; the
// blank-room path still composes room start. All template content is token-free.
test("dashboard templates prefill distinct briefs + channels and compose create-boardroom; blank stays room start (#214)", async () => {
  const root = await makeRoot();
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector(".welcome-template");

    const channelSets = new Set<string>();
    const briefs = new Set<string>();
    const secret = /tgl_|token=|Bearer|\/Users\/|\/home\/|[A-Za-z]:\\/;
    for (const t of ["debug", "review", "planning", "product"]) {
      await page.click(`.welcome-template[data-template="${t}"]`);
      await page.waitForSelector("#create-overlay:not([hidden])");
      await page.waitForSelector("#create-preview:not([hidden])");

      const cmd = (await page.locator("#create-command").textContent()) ?? "";
      const brief = await page.locator("#create-goal").inputValue();
      const channels = ((await page.locator("#create-channels").textContent()) ?? "").replace(/\s+/g, "");

      // The command uses create-boardroom with a channel spec and the template brief.
      assert.match(cmd, /room create-boardroom \S+ --channels \S+/);
      assert.ok(brief.trim().length > 0, `${t} brief is empty`);
      // Token-free and private-path-free content everywhere it could leak.
      assert.equal(secret.test(`${cmd}\n${brief}\n${channels}`), false, `${t} payload leaked a secret/path`);

      channelSets.add(channels);
      briefs.add(brief);

      // Clear the brief while the overlay is still open (visible) so the next
      // template's starter prefills, then close to reach the next card.
      await page.fill("#create-goal", "");
      await page.click("#create-close");
    }
    assert.equal(channelSets.size, 4, "template channel sets are not distinct");
    assert.equal(briefs.size, 4, "template briefs are not distinct");

    // Blank-room path preserved: creating without a template shows no preview and
    // composes the simpler room start command. (The loop already left the brief empty.)
    await page.click("#welcome-create");
    await page.waitForSelector("#create-overlay:not([hidden])");
    assert.equal(await page.locator("#create-preview").isHidden(), true);
    assert.match((await page.locator("#create-command").textContent()) ?? "", /room start \S+/);

    // No horizontal page overflow with the overlay open (long command wraps).
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert.equal(noHScroll, true, "create overlay caused horizontal overflow");
  } finally {
    await browser.close();
    await platform.close();
  }
});

// #215 — the About screen is discoverable from the dashboard (even with no rooms)
// and states the trust boundary accurately, without marketing/pricing overclaim.
test("the About screen is reachable with no rooms and states the trust boundary accurately (#215)", async () => {
  const root = await makeRoot();
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(platform.baseUrl);
    // First-run: no rooms — the About trigger must still be present & accessible.
    await page.waitForSelector('.platform-shell[data-view="empty"]');
    assert.equal(await page.locator("#about-open").evaluate((el) => el.tagName), "BUTTON");

    await page.click("#about-open");
    await page.waitForSelector("#about-overlay:not([hidden])");

    const text = ((await page.locator("#about-overlay").textContent()) ?? "").toLowerCase();
    // Key security / trust-boundary claims — each accurate to how the code behaves.
    assert.match(text, /no central content database/);
    assert.match(text, /host-local storage/);
    assert.match(text, /no mac app permissions/);
    assert.match(text, /never invite tokens or bearer credentials/); // token-free dashboard metadata
    assert.match(text, /can see traffic in transit/); // honest remote-route limitation
    assert.match(text, /never touch a provider/); // local-only rooms stay local
    assert.match(text, /doesn't silently wake external agents/); // no auto-wake overclaim
    // No marketing/pricing/paid overclaim.
    assert.equal(/\$|pricing|free trial|upgrade|per month/i.test(text), false);

    // No horizontal overflow with the overlay open.
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      true
    );

    // Escape closes it (keyboard accessible).
    await page.keyboard.press("Escape");
    await page.locator("#about-overlay").waitFor({ state: "hidden" });
  } finally {
    await browser.close();
    await platform.close();
  }
});

// #210 — device-local archive/delete for "Rooms I'm in": archive hides a row
// (recoverable via the toggle), delete needs an inline confirm and removes only
// the device-local record, controls appear only on joined rows, and everything
// stays token-free.
test("device-local archive/delete for joined rooms — hide/restore, confirm-delete, token-free, host rows unaffected (#210)", async () => {
  const root = await makeRoot();
  const now = new Date().toISOString();
  await recordJoinedRoom(root, { roomId: "room-a", title: "Room A", alias: "me", baseUrl: "http://127.0.0.1:9", joinedAt: now, lastSeen: now });
  await recordJoinedRoom(root, { roomId: "room-b", title: "Room B", alias: "me", baseUrl: "http://127.0.0.1:8", joinedAt: now, lastSeen: now });
  // A host-owned control-plane room — it must NOT get joined lifecycle controls.
  await createControlPlaneRoom(root, roomInput({ room_id: "hosted", title: "Hosted", status: "active" }));

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.platform-shell[data-view="rooms"]');
    await page.waitForSelector(".joined-row");
    assert.equal(await page.locator(".joined-row").count(), 2);

    // Host-owned rooms have NO archive/delete controls (only joined rows do).
    assert.equal(await page.locator(".room-row").count(), 1);
    assert.equal(await page.locator(".room-row .joined-ctl").count(), 0);

    // Archive Room A → hidden by default; the show-archived toggle appears.
    const rowA = page.locator('.joined-row:has(.joined-name:text-is("Room A"))');
    await rowA.locator('[data-action="archive"]').click();
    await page.waitForFunction(() => document.querySelectorAll(".joined-row").length === 1);
    await page.waitForSelector("#joined-show-archived:not([hidden])");
    assert.match((await page.locator("#joined-show-archived").textContent()) ?? "", /show archived \(1\)/);

    // Reveal archived → Room A shows dimmed; unarchive restores it.
    await page.click("#joined-show-archived");
    await page.waitForFunction(() => document.querySelectorAll(".joined-row").length === 2);
    await page.waitForSelector('.joined-row[data-archived="true"]');
    await page.locator('.joined-row[data-archived="true"] [data-action="unarchive"]').click();
    await page.waitForSelector('.joined-row[data-archived="true"]', { state: "detached" });

    // Delete Room B needs an inline confirm (never a native dialog) with honest,
    // token-free copy, then removes only the device-local record.
    const rowB = page.locator('.joined-row:has(.joined-name:text-is("Room B"))');
    await rowB.locator('[data-action="delete"]').click();
    await page.waitForSelector('[data-action="confirm-delete"]');
    const confirmText = (await page.locator(".joined-confirm-msg").textContent()) ?? "";
    assert.match(confirmText, /won't close the host room or notify anyone/i);
    assert.equal(/tgl_|token=|Bearer/i.test(confirmText), false);
    // #255: the old wait here was `every(.joined-name !== "Room B")`, which is
    // already TRUE before this click — opening the confirm bar swaps the row's
    // contents (`showJoinedDeleteConfirm` calls `item.replaceChildren()`), so the
    // name is gone the moment the bar appears. That wait proved nothing, and the
    // API read below then raced the still in-flight delete: on macOS it lost every
    // time, on Linux it usually won and lost only under load. Wait on the server's
    // own end state instead — the delete response, which the handler sends only
    // after the store write is committed — and then on the rail settling from
    // authoritative state. No sleep, and a delete that stops working still fails
    // this test.
    const deleteApplied = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/joined-rooms/delete") &&
        response.status() === 200
    );
    await page.click('[data-action="confirm-delete"]');
    await deleteApplied;
    await page.waitForFunction(() => document.querySelectorAll(".joined-row").length === 1);

    // Token-free rail + API; Room B is gone from the device-local store, Room A stays.
    assert.equal(/tgl_|token=|Bearer/i.test((await page.locator(".room-rail").innerHTML()) ?? ""), false);
    const api = (await (await fetch(`${platform.baseUrl}/joined-rooms`)).json()) as {
      rooms: Array<{ roomId: string }>;
    };
    assert.equal(/tgl_|token=|Bearer/i.test(JSON.stringify(api)), false);
    assert.equal(api.rooms.some((r) => r.roomId === "room-b"), false);
    assert.equal(api.rooms.some((r) => r.roomId === "room-a"), true);
  } finally {
    await browser.close();
    await platform.close();
  }
});

// #210 (RE1) — browser-local archive/delete key by (roomId, baseUrl), so deleting
// one joined room never removes a sibling that shares the same host baseUrl.
test("deleting one browser-local joined room keeps a sibling on the same host (#210)", async () => {
  const root = await makeRoot();
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector(".platform-shell");
    // Two browser-local joined records that share a baseUrl but differ by roomId.
    await page.evaluate(() => {
      const ts = "2026-07-01T00:00:00.000Z";
      window.localStorage.setItem(
        "agentgather.joinedRooms",
        JSON.stringify({
          rooms: [
            { roomId: "room-x", title: "Room X", alias: "me", baseUrl: "http://127.0.0.1:9/team", joinedAt: ts, lastSeen: ts },
            { roomId: "room-y", title: "Room Y", alias: "me", baseUrl: "http://127.0.0.1:9/team", joinedAt: ts, lastSeen: ts }
          ]
        })
      );
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll(".joined-row").length === 2);

    // Delete Room X (inline confirm) → only Room Y remains, in the DOM and storage.
    await page.locator('.joined-row:has(.joined-name:text-is("Room X"))').locator('[data-action="delete"]').click();
    await page.click('[data-action="confirm-delete"]');
    await page.waitForFunction(() => {
      const names = [...document.querySelectorAll(".joined-name")].map((n) => n.textContent);
      return names.length === 1 && names[0] === "Room Y";
    });
    const stored = JSON.parse(
      (await page.evaluate(() => window.localStorage.getItem("agentgather.joinedRooms"))) ?? "{}"
    ) as { rooms: Array<{ roomId: string }> };
    assert.equal(stored.rooms.length, 1);
    assert.equal(stored.rooms[0]?.roomId, "room-y");
  } finally {
    await browser.close();
    await platform.close();
  }
});

// #211 × #210 — deleting a joined room disassociates its dashboard-origin cached
// history (device-local), so no orphaned backup lingers after the row is removed.
test("deleting a joined room clears its dashboard-origin cached history (#211/#210)", async () => {
  const root = await makeRoot();
  const now = new Date().toISOString();
  await recordJoinedRoom(root, { roomId: "cached-room", title: "Cached Room", alias: "me", baseUrl: "http://127.0.0.1:9", joinedAt: now, lastSeen: now });

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.joined-row:has(.joined-name:text-is("Cached Room"))');
    // Seed a dashboard-origin cached-history entry for that room.
    await page.evaluate(() =>
      window.localStorage.setItem(
        "agentgather.history.cached-room",
        JSON.stringify({ messages: [{ id: 1, from: "a", ts: "2026-07-01T00:00:00.000Z", type: "chat", text: "hi" }] })
      )
    );

    await page.locator('.joined-row:has(.joined-name:text-is("Cached Room"))').locator('[data-action="delete"]').click();
    await page.click('[data-action="confirm-delete"]');
    await page.waitForFunction(() => document.querySelectorAll(".joined-row").length === 0);

    // The device-local cached history for that room is cleared (disassociation).
    assert.equal(await page.evaluate(() => window.localStorage.getItem("agentgather.history.cached-room")), null);
  } finally {
    await browser.close();
    await platform.close();
  }
});

// #233 — the top rail is ONE merged room list: hosted rooms first (each carrying a
// compact `host` tag), then joined rooms by most-recent activity. The old
// "Your rooms" / "Rooms I'm in" section split is gone; joined affordances stay.
test("the unified rail merges hosted + joined into one host-tagged list, hosted first (#233)", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "alpha", title: "Alpha Room", status: "active" }));
  await createControlPlaneRoom(root, roomInput({ room_id: "beta", title: "Beta Room", status: "paused" }));
  const older = "2026-07-10T00:00:00.000Z";
  const newer = "2026-07-13T00:00:00.000Z";
  await recordJoinedRoom(root, { roomId: "older-join", title: "Older Join", alias: "me", baseUrl: "http://127.0.0.1:8", joinedAt: older, lastSeen: older });
  await recordJoinedRoom(root, { roomId: "recent-join", title: "Recent Join", alias: "me", baseUrl: "http://127.0.0.1:9", joinedAt: newer, lastSeen: newer });

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.platform-shell[data-view="rooms"]');
    await page.waitForSelector(".joined-row");

    // The list split is gone: the separate joined room list is removed and both
    // hosted and joined rows live in the one merged #room-list.
    assert.equal(await page.locator("#joined-list").count(), 0);
    assert.equal(await page.locator("#joined-more").count(), 0);
    assert.equal(await page.locator("#room-list").count(), 1);
    assert.equal(await page.locator("#room-list .room-row").count(), 2);
    assert.equal(await page.locator("#room-list .joined-row").count(), 2);

    // Host-owned rows carry a visible `host` tag; joined rows keep reachability.
    assert.equal(await page.locator('.room-row .room-tag[data-tag="host"]').count(), 2);
    assert.equal((await page.locator('.room-row[data-room-id="alpha"] .room-tag').textContent())?.trim(), "host");
    assert.equal(await page.locator(".joined-row .joined-reach").count(), 2);
    // Joined rows must NOT carry the host tag.
    assert.equal(await page.locator(".joined-row .room-tag").count(), 0);

    // Order: both hosted rows come before any joined row; joined rows are ordered
    // by most-recent activity (Recent Join before Older Join).
    const kinds = await page.locator("#room-list > li").evaluateAll((lis) =>
      lis.map((li) => (li.classList.contains("joined-row") ? "joined" : li.querySelector(".room-row") ? "host" : "?"))
    );
    assert.deepEqual(kinds, ["host", "host", "joined", "joined"]);
    const joinedNames = await page.locator(".joined-row .joined-name").evaluateAll((els) => els.map((e) => e.textContent?.trim()));
    assert.deepEqual(joinedNames, ["Recent Join", "Older Join"]);

    // Selecting a hosted row from the merged list still enters the room state.
    await page.click('.room-row[data-room-id="alpha"]');
    await page.waitForSelector("#lower-room:not([hidden])");
    assert.equal((await page.locator("#crumb").textContent())?.trim(), "/ Alpha Room / #general");

    // No raw token anywhere in the merged rail.
    assert.equal(/tgl_|token=|Bearer/i.test((await page.locator(".room-rail").innerHTML()) ?? ""), false);
  } finally {
    await browser.close();
    await platform.close();
  }
});

// #233 — the ~34% / ~66% split holds: with a long room list the rooms region caps
// at ~1/3 with its OWN scroll, the lower region keeps ~2/3, and expanding the
// merged list's view-more reveals rows inside the rooms scroll without moving the
// lower region (no layout jump, other section never hidden).
test("the rail keeps a ~1/3-2/3 split and view-more expands within the rooms scroll (#233)", async () => {
  const root = await makeRoot();
  for (let i = 0; i < 12; i++) {
    await createControlPlaneRoom(root, roomInput({ room_id: `room-${i}`, title: `room-${i}`, status: "active" }));
  }

  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.platform-shell[data-view="rooms"]');
    await page.waitForSelector("#rooms-more:not([hidden])");

    // 12 rooms, cap 6 → 6 collapsed behind the merged list's single control.
    assert.equal(await page.locator("#room-list > li").count(), 12);
    assert.equal(await page.locator("#room-list > li:not(.is-collapsed)").count(), 6);
    assert.match((await page.locator("#rooms-more").textContent()) ?? "", /show 6 more/);

    // Both regions own their scroll; the rooms region caps near 1/3, the lower near
    // 2/3, and the rooms content overflows (so its cap is doing real work).
    const layout = await page.evaluate(() => {
      const rail = document.querySelector(".room-rail") as HTMLElement;
      const rooms = document.querySelector(".rail-rooms") as HTMLElement;
      const lower = document.querySelector(".rail-lower") as HTMLElement;
      return {
        roomsScroll: getComputedStyle(rooms).overflowY,
        lowerScroll: getComputedStyle(lower).overflowY,
        roomsRatio: rooms.getBoundingClientRect().height / rail.getBoundingClientRect().height,
        lowerRatio: lower.getBoundingClientRect().height / rail.getBoundingClientRect().height,
        roomsOverflows: rooms.scrollHeight > rooms.clientHeight,
        lowerTop: Math.round(lower.getBoundingClientRect().top)
      };
    });
    assert.equal(layout.roomsScroll, "auto");
    assert.equal(layout.lowerScroll, "auto");
    assert.ok(layout.roomsRatio >= 0.28 && layout.roomsRatio <= 0.4, `rooms region was ${layout.roomsRatio} of the rail, expected ~1/3`);
    assert.ok(layout.lowerRatio >= 0.55, `lower region was ${layout.lowerRatio} of the rail, expected ~2/3`);
    assert.equal(layout.roomsOverflows, true, "rooms region did not overflow its capped height");

    // Expanding view-more reveals all rows inside the rooms scroll; the lower region
    // does not move (no layout jump, never pushed off-screen).
    await page.click("#rooms-more");
    assert.equal(await page.locator("#room-list > li:not(.is-collapsed)").count(), 12);
    assert.match((await page.locator("#rooms-more").textContent()) ?? "", /show less/);
    const lowerTopAfter = await page.evaluate(() => Math.round((document.querySelector(".rail-lower") as HTMLElement).getBoundingClientRect().top));
    assert.equal(lowerTopAfter, layout.lowerTop, "expanding the room list shifted the lower region");
  } finally {
    await browser.close();
    await platform.close();
  }
});

// #233 — the channel nav renders `room.channels` ({id,name,type}) when the
// control-plane payload provides them, and falls back to #general when absent.
test("channel nav renders room.channels from the payload and falls back to #general (#233)", async () => {
  const root = await makeRoot();
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  const roster = [{ alias: "host", kind: "human", role: "host", status: "attending" }];
  const rooms = [
    {
      room_id: "multi",
      title: "Multi",
      status: "active",
      owner_user_id: "owner-1",
      roster,
      route_health: { reachable: true, host_connected: true },
      channels: [
        { id: "general", name: "general", type: "chat" },
        { id: "design", name: "design", type: "forum" },
        { id: "ops", name: "ops", type: "chat" }
      ]
    },
    { room_id: "plain", title: "Plain", status: "active", owner_user_id: "owner-1", roster, route_health: { reachable: true, host_connected: true } }
  ];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.route("**/rooms**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (/\/rooms\/[^/]+\/messages$/.test(pathname)) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, messages: [], next_since_id: 0, host_log_available: true }) });
        return;
      }
      if (pathname.endsWith("/rooms")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, rooms }) });
        return;
      }
      await route.continue();
    });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.room-row[data-room-id="multi"]');

    // Payload channels render with name + type; the first is active.
    await page.click('.room-row[data-room-id="multi"]');
    await page.waitForSelector("#lower-room:not([hidden])");
    assert.equal(await page.locator("#channel-nav .channel-row").count(), 3);
    const names = await page.locator("#channel-nav .channel-name").evaluateAll((els) => els.map((e) => e.textContent?.trim()));
    assert.deepEqual(names, ["general", "design", "ops"]);
    const types = await page.locator("#channel-nav .channel-type").evaluateAll((els) => els.map((e) => e.textContent?.trim()));
    assert.deepEqual(types, ["chat", "forum", "chat"]);
    await page.waitForSelector("#channel-nav .channel-row.on:has-text('general')");

    // A room with no channels falls back to the single #general chat channel.
    await page.click("#brand-home");
    await page.click('.room-row[data-room-id="plain"]');
    await page.waitForSelector("#lower-room:not([hidden])");
    assert.equal(await page.locator("#channel-nav .channel-row").count(), 1);
    assert.equal((await page.locator("#channel-nav .channel-name").textContent())?.trim(), "general");
  } finally {
    await browser.close();
    await platform.close();
  }
});

// #233 — the channel nav caps at 8 behind its own view-more control (independent of
// the rooms cap of 6).
test("channel nav caps at 8 with a view-more control (#233)", async () => {
  const root = await makeRoot();
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  const roster = [{ alias: "host", kind: "human", role: "host", status: "attending" }];
  const channels = Array.from({ length: 10 }, (_unused, i) => ({ id: i === 0 ? "general" : `chan-${i}`, name: i === 0 ? "general" : `chan-${i}`, type: "chat" }));
  const rooms = [{ room_id: "big", title: "Big", status: "active", owner_user_id: "owner-1", roster, route_health: { reachable: true, host_connected: true }, channels }];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.route("**/rooms**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (/\/rooms\/[^/]+\/messages$/.test(pathname)) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, messages: [], next_since_id: 0, host_log_available: true }) });
        return;
      }
      if (pathname.endsWith("/rooms")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, rooms }) });
        return;
      }
      await route.continue();
    });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.room-row[data-room-id="big"]');
    await page.click('.room-row[data-room-id="big"]');
    await page.waitForSelector("#channels-more:not([hidden])");

    // 10 channels, cap 8 → 2 collapsed behind the channel view-more control.
    assert.equal(await page.locator("#channel-nav > li").count(), 10);
    assert.equal(await page.locator("#channel-nav > li:not(.is-collapsed)").count(), 8);
    assert.match((await page.locator("#channels-more").textContent()) ?? "", /show 2 more/);

    await page.click("#channels-more");
    assert.equal(await page.locator("#channel-nav > li:not(.is-collapsed)").count(), 10);
    assert.match((await page.locator("#channels-more").textContent()) ?? "", /show less/);
  } finally {
    await browser.close();
    await platform.close();
  }
});

// #248 — the alias stored on an existing dashboard row IS the selected local
// opening identity. A stale room tab authenticated as another participant still
// bridges its own metadata; that refresh may move non-identity fields (last-seen)
// but must never repoint the row at the tab's credential, or a later dashboard
// open would silently post as the wrong participant.
test("a stale agent room tab refreshes metadata but cannot overwrite the selected joined-room alias (#248)", async () => {
  const root = await makeRoot();
  const humanToken = "tgl_selected_human_identity";
  const agentToken = "tgl_stale_agent_identity";
  await createRoom({ root, roomId: "identity-room", hostAlias: "host", briefBody: "Identity authority brief." });
  await writeParticipants(root, "identity-room", [
    { ...participant("host", "human", true, "tgl_identity_room_host"), display_name: "Host" },
    { ...participant("project7", "human", false, humanToken), display_name: "project7" },
    participant("agent-bot", "agent", false, agentToken)
  ]);
  // Both credentials are valid on this device; the dashboard row selects the human.
  await writeToken(root, "identity-room", "project7", humanToken);
  await writeToken(root, "identity-room", "agent-bot", agentToken);

  const roomEntry = await listen(
    createRoomHttpServer({ root, roomId: "identity-room", baseUrl: "http://127.0.0.1:0", rateLimitPerMinute: 1000 })
  );
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const seeded = "2026-01-01T00:00:00.000Z";
  await recordJoinedRoom(root, {
    roomId: "identity-room",
    title: "Identity Room",
    alias: "project7",
    baseUrl: roomEntry.baseUrl,
    joinedAt: seeded,
    lastSeen: seeded
  });

  const browser = await chromium.launch();
  try {
    // The stale tab: authenticated as the agent, still carrying ?dashboard= from an
    // earlier open, so it bridges on load exactly like the reported regression.
    const stalePage = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await stalePage.goto(`${roomEntry.baseUrl}/?dashboard=${encodeURIComponent(platform.baseUrl)}#token=${agentToken}`);
    await stalePage.waitForSelector("text=Identity authority brief.");

    // The bridge write landed once last-seen moves off the seeded value — that is
    // the non-identity metadata the bridge IS allowed to refresh.
    const readRow = async (): Promise<{ alias: string; title: string; lastSeen: string } | undefined> => {
      const payload = (await (await fetch(`${platform.baseUrl}/joined-rooms`)).json()) as {
        rooms: Array<{ roomId: string; alias: string; title: string; lastSeen: string }>;
      };
      return payload.rooms.find((room) => room.roomId === "identity-room");
    };
    let row = await readRow();
    for (let attempt = 0; attempt < 100 && row?.lastSeen === seeded; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      row = await readRow();
    }
    assert.notEqual(row?.lastSeen, seeded);
    // ...and the selected identity did not move with it. Title preservation (#216)
    // still holds against the slug-only title the bridge carries.
    assert.equal(row?.alias, "project7");
    assert.equal(row?.title, "Identity Room");

    // Opening the row resolves the selected human credential, never the stale agent's.
    const openUrl = new URL(`${platform.baseUrl}/joined-rooms/open`);
    openUrl.searchParams.set("room_id", "identity-room");
    openUrl.searchParams.set("base_url", roomEntry.baseUrl);
    const redirect = await fetch(openUrl, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get("location") ?? "", new RegExp(`#token=${humanToken}(&snapshot=[A-Za-z0-9_-]+)?$`));

    // The dashboard list and rail stay token-free throughout.
    const api = (await (await fetch(`${platform.baseUrl}/joined-rooms`)).json()) as { rooms: unknown[] };
    assert.equal(/tgl_|Bearer|token=/i.test(JSON.stringify(api)), false);
    const dashPage = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await dashPage.goto(platform.baseUrl);
    await dashPage.waitForSelector(".joined-row");
    assert.equal(/tgl_|Bearer|token=/i.test((await dashPage.locator(".room-rail").innerHTML()) ?? ""), false);
  } finally {
    await browser.close();
    await platform.close();
    await roomEntry.close();
  }
});

// #248 — the other half of the contract: an EXPLICIT local import is still the
// authority that changes which participant a row opens as.
test("an explicit invite import intentionally changes the selected joined-room identity (#248)", async () => {
  const root = await makeRoot();
  const humanToken = "tgl_import_human_identity";
  const agentToken = "tgl_import_agent_identity";
  await createRoom({ root, roomId: "import-room", hostAlias: "host", briefBody: "Explicit import brief." });
  await writeParticipants(root, "import-room", [
    { ...participant("host", "human", true, "tgl_import_room_host"), display_name: "Host" },
    { ...participant("project7", "human", false, humanToken), display_name: "project7" },
    participant("agent-bot", "agent", false, agentToken)
  ]);
  await writeToken(root, "import-room", "project7", humanToken);

  const roomEntry = await listen(
    createRoomHttpServer({ root, roomId: "import-room", baseUrl: "http://127.0.0.1:0", rateLimitPerMinute: 1000 })
  );
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const now = new Date().toISOString();
  await recordJoinedRoom(root, {
    roomId: "import-room",
    title: "Import Room",
    alias: "project7",
    baseUrl: roomEntry.baseUrl,
    joinedAt: now,
    lastSeen: now
  });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector(".joined-row");

    // Pasting the agent's invite is a deliberate identity change, not an observation.
    await page.fill("#joined-input", `${roomEntry.baseUrl}/#token=${agentToken}`);
    await page.click("#joined-add-button");
    await page.waitForFunction(
      () => [...document.querySelectorAll(".joined-sub")].some((n) => (n.textContent || "").includes("agent-bot")),
      { timeout: 15000 }
    );

    const api = (await (await fetch(`${platform.baseUrl}/joined-rooms`)).json()) as {
      rooms: Array<{ roomId: string; alias: string; title: string }>;
    };
    const row = api.rooms.find((room) => room.roomId === "import-room");
    assert.equal(row?.alias, "agent-bot");
    assert.equal(row?.title, "Import Room");
    assert.equal(api.rooms.filter((room) => room.roomId === "import-room").length, 1);
    assert.equal(/tgl_|Bearer|token=/i.test(JSON.stringify(api)), false);

    // The row now opens as the newly selected participant.
    const openUrl = new URL(`${platform.baseUrl}/joined-rooms/open`);
    openUrl.searchParams.set("room_id", "import-room");
    openUrl.searchParams.set("base_url", roomEntry.baseUrl);
    const redirect = await fetch(openUrl, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get("location") ?? "", new RegExp(`#token=${agentToken}(&snapshot=[A-Za-z0-9_-]+)?$`));
  } finally {
    await browser.close();
    await platform.close();
    await roomEntry.close();
  }
});

// #247 — a joined room whose host has stopped serving must still be readable from
// the dashboard. While the host is reachable the room surface hands the dashboard
// the history it has ALREADY loaded; once the host is gone, selecting the row
// renders that device-local snapshot here instead of following a redirect to a
// host that cannot answer.
test("a dashboard-opened room bridges its loaded history, and the unreachable row then renders it offline (#247)", async () => {
  const root = await makeRoot();
  const humanToken = "tgl_snapshot_human_identity";
  await createRoom({ root, roomId: "snap-room", hostAlias: "host", briefBody: "Snapshot bridge brief." });
  await writeParticipants(root, "snap-room", [
    { ...participant("host", "human", true, "tgl_snap_room_host"), display_name: "Host" },
    { ...participant("project7", "human", false, humanToken), display_name: "project7" }
  ]);
  await writeToken(root, "snap-room", "project7", humanToken);
  const roomEntry = await listen(
    createRoomHttpServer({ root, roomId: "snap-room", baseUrl: "http://127.0.0.1:0", rateLimitPerMinute: 1000 })
  );
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const now = new Date().toISOString();
  await recordJoinedRoom(root, {
    roomId: "snap-room",
    title: "Snapshot Room",
    alias: "project7",
    baseUrl: roomEntry.baseUrl,
    joinedAt: now,
    lastSeen: now
  });
  // Host-authored history that this participant will actually load — including a
  // credential-shaped body, which must never reach the snapshot intact.
  for (const text of ["first saved line", "second saved line", `leaked ${humanToken} and http://evil.test/card`]) {
    const posted = await fetch(`${roomEntry.baseUrl}/messages`, {
      method: "POST",
      headers: { Authorization: "Bearer tgl_snap_room_host", "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    assert.equal(posted.status, 201);
  }

  // Both servers are already listening, so the browser launch goes INSIDE the try:
  // a launch failure must still run teardown, or the open handles keep the test
  // process alive long after the failure and the run looks like a hang.
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  // The host is stopped mid-test on purpose; this keeps the teardown honest if an
  // assertion fires before that point, so a failure never leaves a live handle.
  let hostStopped = false;
  const stopHost = async (): Promise<void> => {
    if (hostStopped) return;
    hostStopped = true;
    await roomEntry.close();
  };
  try {
    browser = await chromium.launch();
    // The real open path mints the bridge capability; take the redirect the
    // dashboard would have followed.
    const openUrl = new URL(`${platform.baseUrl}/joined-rooms/open`);
    openUrl.searchParams.set("room_id", "snap-room");
    openUrl.searchParams.set("base_url", roomEntry.baseUrl);
    const redirect = await fetch(openUrl, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    const roomUrl = redirect.headers.get("location") ?? "";
    assert.match(roomUrl, /snapshot=/);

    const roomPage = await browser!.newPage({ viewport: { width: 1100, height: 760 } });
    await roomPage.goto(roomUrl);
    await roomPage.waitForSelector("text=second saved line");
    // The capability never survives in the address bar.
    assert.equal(roomPage.url().includes("snapshot="), false);
    assert.equal(roomPage.url().includes("token="), false);

    // The bridge landed: the dashboard now owns a snapshot of what was loaded.
    const readSnapshot = async (): Promise<{ cursor: number; savedAt: string; messages: Array<{ text: string }> } | null> => {
      const url = new URL(`${platform.baseUrl}/joined-rooms/history`);
      url.searchParams.set("room_id", "snap-room");
      url.searchParams.set("base_url", roomEntry.baseUrl);
      return ((await (await fetch(url)).json()) as { snapshot: { cursor: number; savedAt: string; messages: Array<{ text: string }> } | null }).snapshot;
    };
    let snapshot = await readSnapshot();
    for (let attempt = 0; attempt < 100 && (snapshot?.messages.length ?? 0) < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      snapshot = await readSnapshot();
    }
    assert.equal(snapshot?.messages.length, 3);
    assert.equal(snapshot?.cursor, 3);
    // Redacted on the way in — the token and card URL are gone, the prose stays.
    const leaked = snapshot?.messages.at(-1)?.text ?? "";
    assert.equal(/tgl_|Bearer|token=|evil\.test/i.test(leaked), false);
    assert.match(leaked, /\[redacted-token\]/);

    // Snapshot content never appears on the token-free metadata surface.
    const metadata = await (await fetch(`${platform.baseUrl}/joined-rooms`)).text();
    assert.equal(metadata.includes("first saved line"), false);
    assert.equal(/tgl_|Bearer|token=/i.test(metadata), false);

    // The host goes away — this is the restart/shutdown case the ticket is about.
    await roomPage.close();
    await stopHost();

    const dashPage = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    await dashPage.goto(platform.baseUrl);
    await dashPage.waitForSelector('.joined-row[data-reachability="unreachable"]');
    await dashPage.click(".joined-row");

    // It stayed in the dashboard — no navigation attempt at the dead host.
    await dashPage.waitForSelector('#history-source[data-source="snapshot"]');
    assert.equal(dashPage.url().startsWith(platform.baseUrl), true);
    assert.equal(
      (await dashPage.locator("#history-source-label").textContent()) ?? "",
      "Local snapshot · host offline"
    );
    // The saved transcript is here, bounded by an honest cursor + saved-at line.
    await dashPage.waitForSelector("text=first saved line");
    const band = (await dashPage.locator("#chat-offline").textContent()) ?? "";
    assert.match(band, /saved on this device up to message #3/);
    assert.match(band, /nothing can be sent until the host resumes/i);
    assert.equal(/newer|unseen|complete history/i.test(band), false);
    // Every host-owned mutation is absent, not fabricated-and-disabled.
    assert.equal(await dashPage.locator("#host-controls").isVisible(), false);
    assert.equal(await dashPage.locator("#info-panel").isVisible(), false);
    assert.equal(await dashPage.locator("#shell-timeline .shell-message").count(), 3);
    // And nothing token-shaped is rendered.
    assert.equal(/tgl_|Bearer|token=/i.test((await dashPage.locator(".room-detail").innerHTML()) ?? ""), false);
  } finally {
    await browser?.close();
    await platform.close();
    await stopHost();
  }
});

// #247 — the no-snapshot case must be honest rather than empty-and-mysterious, and
// the way back to the live room is gated on the reachability probe actually
// reporting the host is back. Nothing here may imply history exists locally.
test("an unreachable room with no snapshot shows an honest empty offline state, and retry opens only once the host is live (#247)", async () => {
  const root = await makeRoot();
  // A port with nothing listening: the row probes unreachable.
  const port = await getFreePort();
  const roomBaseUrl = `http://127.0.0.1:${port}`;
  const now = new Date().toISOString();
  await recordJoinedRoom(root, {
    roomId: "gone-room",
    title: "Gone Room",
    alias: "project7",
    baseUrl: roomBaseUrl,
    joinedAt: now,
    lastSeen: now
  });
  await createRoom({ root, roomId: "gone-room", hostAlias: "host", briefBody: "Recovered brief." });
  await writeParticipants(root, "gone-room", [
    { ...participant("host", "human", true, "tgl_gone_room_host"), display_name: "Host" },
    { ...participant("project7", "human", false, "tgl_gone_room_human"), display_name: "project7" }
  ]);
  await writeToken(root, "gone-room", "project7", "tgl_gone_room_human");
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let host: { close: () => Promise<void> } | null = null;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.joined-row[data-reachability="unreachable"]');
    await page.click(".joined-row");

    // Stayed in the dashboard, said plainly that nothing is saved, claimed nothing.
    await page.waitForSelector('#history-source[data-source="snapshot"]');
    assert.equal(page.url().startsWith(platform.baseUrl), true);
    const band = (await page.locator("#chat-offline").textContent()) ?? "";
    assert.match(band, /nothing from this room is saved on this device yet/i);
    assert.equal(/newer|unseen|up to message/i.test(band), false);
    assert.equal(await page.locator("#shell-timeline .shell-message").count(), 0);
    assert.equal(await page.locator("#host-controls").isVisible(), false);

    // While the host is still down, retry stays a retry — it never offers an open.
    await page.click("#snapshot-retry");
    await page.waitForFunction(
      () => (document.querySelector("#snapshot-retry")?.textContent || "").includes("Still offline")
    );
    assert.equal(await page.locator('#snapshot-retry[data-live="true"]').count(), 0);

    // The host comes back on the same base URL; now the probe can say so.
    host = await listenOn(
      createRoomHttpServer({ root, roomId: "gone-room", baseUrl: roomBaseUrl, rateLimitPerMinute: 1000 }),
      port
    );
    await page.click("#snapshot-retry");
    await page.waitForSelector('#snapshot-retry[data-live="true"]');
    assert.match((await page.locator("#snapshot-retry").textContent()) ?? "", /Host is back/);
  } finally {
    await browser?.close();
    await platform.close();
    if (host !== null) await host.close();
  }
});

// #247 — the saved cursor is a claim about what this device holds, and the offline
// view must not overstate it: a snapshot that stops at #2 says so, shows exactly
// those two rows, and reads without horizontal overflow on a narrow window.
test("the offline view is bounded by its saved cursor and holds up at narrow width (#247)", async () => {
  const root = await makeRoot();
  const port = await getFreePort();
  const roomBaseUrl = `http://127.0.0.1:${port}`;
  const now = new Date().toISOString();
  await recordJoinedRoom(root, {
    roomId: "stale-room",
    title: "Stale Room",
    alias: "project7",
    baseUrl: roomBaseUrl,
    joinedAt: now,
    lastSeen: now
  });
  // This device only ever received the first two messages of a longer room. One of
  // them is authored by a participant aliased after a card URL (#247, @re2): the
  // rendered dashboard must show the redacted value, never the credential.
  await recordJoinedHistory(root, {
    roomId: "stale-room",
    baseUrl: roomBaseUrl,
    messages: [
      { id: 1, from: "https://evil.example/card/abc123?token=tgl_leaked_secret_value", ts: now, type: "chat", text: "saved one" },
      { id: 2, from: "project7", ts: now, type: "chat", text: "saved two" }
    ],
    forumPosts: [
      {
        id: "p1",
        channel: "design",
        title: "Saved forum thread",
        author: "https://evil.example/card/xyz789",
        ts: now,
        status: "open",
        body: "forum body kept locally",
        comments: [{ id: "c1", author: "host", ts: now, body: "a saved comment" }]
      }
    ],
    savedAt: now
  });
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.joined-row[data-reachability="unreachable"]');
    await page.click(".joined-row");
    await page.waitForSelector('#history-source[data-source="snapshot"]');

    // Exactly what was saved: two chat rows plus the saved forum thread.
    await page.waitForSelector("text=saved two");
    assert.equal(await page.locator("#shell-timeline .shell-message").count(), 3);
    assert.equal(await page.locator(".snapshot-forum").count(), 1);
    await page.waitForSelector("text=Saved forum thread");
    await page.waitForSelector("text=a saved comment");
    // No nested card: the forum entry is a transcript row like any other.
    assert.equal(await page.locator(".snapshot-forum .snapshot-forum").count(), 0);

    // #279 strengthened this. #247 asserted that a credential-shaped stored author
    // reached the DOM only in its REDACTED form; a snapshot row now shows no stored
    // author at all, because a device-local record cannot vouch for who wrote it.
    // The redaction is still in force on the way in — it is simply no longer the
    // last line of defence for this field, since the field never renders.
    assert.equal(
      (await page.locator("#shell-timeline .shell-message").first().locator(".shell-message-from").textContent()) ?? "",
      "local copy"
    );
    assert.equal(
      (await page.locator(".snapshot-forum .shell-message-from").textContent()) ?? "",
      "local copy"
    );
    // The redacted marker itself must not survive as an author either.
    assert.equal(
      (await page.locator("#shell-timeline").innerHTML()).includes("[redacted-url]"),
      false,
      "no stored author string reaches the DOM in any form"
    );
    const rendered = (await page.locator("#shell-timeline").innerHTML()) ?? "";
    assert.equal(/tgl_|Bearer|token=|evil\.example/i.test(rendered), false);

    const band = (await page.locator("#chat-offline").textContent()) ?? "";
    assert.match(band, /up to message #2/);
    assert.equal(/newer|unseen|complete history|all messages/i.test(band), false);

    // Desktop and narrow: the offline surfaces wrap inside their own boxes rather
    // than pushing content sideways. Measured per element, matching the existing
    // responsive checks in this suite — the shell's own document-level narrow
    // behaviour is pre-existing and not touched here.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const fits = await page.evaluate(() => {
        const within = (selector: string): boolean => {
          const element = document.querySelector(selector);
          if (element === null) return true;
          return element.scrollWidth <= element.clientWidth + 1;
        };
        return (
          within("#chat-offline") &&
          within("#history-source") &&
          within("#snapshot-retry") &&
          within(".snapshot-forum") &&
          within(".snapshot-forum-title") &&
          within(".snapshot-forum-comment") &&
          within("#shell-timeline")
        );
      });
      assert.equal(fits, true, `offline snapshot content overflowed at width ${width}`);
    }
  } finally {
    await browser?.close();
    await platform.close();
  }
});

// #279 — the dashboard renders the SAME stored records as the room page, through a
// separate renderer that had none of #278's provenance rules: it printed the stored
// alias raw and routed a stored `system` record to the room's own voice. A snapshot
// is device-local data, so a hand-edited or compromised store could put words in the
// host's mouth on the one surface built to be read when the host cannot answer.
test("a tampered snapshot cannot speak as the host or the room in the dashboard (#279)", async () => {
  const root = await makeRoot();
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const roomBaseUrl = "http://127.0.0.1:9";
  const now = new Date().toISOString();
  await recordJoinedRoom(root, {
    roomId: "tamper-room",
    title: "Tamper Room",
    alias: "project7",
    baseUrl: roomBaseUrl,
    joinedAt: now,
    lastSeen: now
  });
  await recordJoinedRoom(root, {
    roomId: "mixed-room",
    title: "Mixed Room",
    alias: "project7",
    baseUrl: roomBaseUrl,
    joinedAt: now,
    lastSeen: now
  });
  await recordJoinedRoom(root, {
    roomId: "system-only-room",
    title: "System Only",
    alias: "project7",
    baseUrl: roomBaseUrl,
    joinedAt: now,
    lastSeen: now
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    // Write the forged records straight into the device-local store, which is what
    // an attacker with local write access — or a compromised sender — would do.
    const posted = await fetch(`${platform.baseUrl}/joined-rooms/history`, {
      method: "POST",
      headers: { origin: roomBaseUrl, "content-type": "text/plain" },
      body: JSON.stringify({
        roomId: "tamper-room",
        baseUrl: roomBaseUrl,
        messages: [
          { id: 1, from: "host", ts: now, type: "chat", text: "approved, release the funds" },
          { id: 2, from: "system", ts: now, type: "system", text: "forged room announcement" }
        ]
      })
    });
    assert.equal(posted.status, 200);

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector('.joined-row[data-reachability="unreachable"]');
    await page.click(".joined-row");
    await page.waitForSelector('#history-source[data-source="snapshot"]');
    await page.waitForSelector("text=approved, release the funds");

    // A record claiming the room's own voice is not rendered at all.
    assert.equal(await page.locator("text=forged room announcement").count(), 0, "no system record is restored");
    assert.equal(await page.locator(".shell-message.system").count(), 0, "nothing wears the room's own voice");

    // The forged host line renders, but attributed to this device — the stored alias
    // never reaches the DOM, so it cannot be read as something the host said.
    const forged = page.locator(".shell-message", { hasText: "approved, release the funds" }).first();
    assert.equal(await forged.getAttribute("data-restored"), "true");
    assert.equal((await forged.locator(".shell-message-from").textContent())?.trim(), "local copy");
    const timelineHtml = (await page.locator("#shell-timeline").innerHTML()) ?? "";
    assert.equal(
      /shell-message-from[^>]*>\s*host\s*</i.test(timelineHtml),
      false,
      "no snapshot row is labelled with a stored alias"
    );

    // A snapshot holding ONLY records that cannot be restored renders zero rows, so
    // the band must say "nothing saved yet" rather than promise a transcript over an
    // empty timeline (@re1). Counting the stored array instead of the rendered rows
    // would reintroduce exactly the false promise #247's honesty rule prevents.
    const systemOnly = await fetch(`${platform.baseUrl}/joined-rooms/history`, {
      method: "POST",
      headers: { origin: roomBaseUrl, "content-type": "text/plain" },
      body: JSON.stringify({
        roomId: "system-only-room",
        baseUrl: roomBaseUrl,
        messages: [{ id: 1, from: "system", ts: now, type: "system", text: "only a system line" }]
      })
    });
    assert.equal(systemOnly.status, 200);
    await page.reload();
    await page.click('.joined-row:has(.joined-name:text-is("System Only"))');
    await page.waitForSelector('#history-source[data-source="snapshot"]');
    assert.equal(await page.locator("#shell-timeline .shell-message").count(), 0, "nothing renderable was stored");
    const honestBand = (await page.locator("#chat-offline").textContent()) ?? "";
    // Records ARE saved here — just none that can be shown. Saying "nothing is
    // saved" would understate, which is safer than the promises this PR removed but
    // still not true (@re1).
    assert.match(honestBand, /saved copy holds no readable history/);
    assert.equal(
      /nothing from this room is saved on this device yet/.test(honestBand),
      false,
      "a store that holds unreadable records is not described as empty"
    );
    assert.equal(/transcript saved on this device/.test(honestBand), false, "no transcript is promised over an empty view");

    // The band's OTHER claim — its extent — must also describe what rendered. A
    // snapshot whose newest record is filtered would otherwise show one row and
    // name the id above it (@re2). Announcements are routinely the last line, so
    // this needs no tampering to reach.
    const mixed = await fetch(`${platform.baseUrl}/joined-rooms/history`, {
      method: "POST",
      headers: { origin: roomBaseUrl, "content-type": "text/plain" },
      body: JSON.stringify({
        roomId: "mixed-room",
        baseUrl: roomBaseUrl,
        messages: [
          { id: 1, from: "project7", ts: now, type: "chat", text: "the only visible line" },
          { id: 2, from: "system", ts: now, type: "system", text: "the host has closed this room" }
        ]
      })
    });
    assert.equal(mixed.status, 200);
    await page.reload();
    await page.click('.joined-row:has(.joined-name:text-is("Mixed Room"))');
    await page.waitForSelector('#history-source[data-source="snapshot"]');
    await page.waitForSelector("text=the only visible line");
    assert.equal(await page.locator("#shell-timeline .shell-message").count(), 1, "only the renderable row shows");
    const extentBand = (await page.locator("#chat-offline").textContent()) ?? "";
    assert.match(extentBand, /up to message #1/);
    assert.equal(/up to message #2/.test(extentBand), false, "the band never names an id it did not show");
    // The time is a fact about RECEIPT, not about the transcript being current as of
    // then (@head): the room may have moved on unseen, and a filtered newest record
    // means the last thing received is not always the last thing shown.
    // The mixed snapshot HAD a record filtered out, so the receipt time would name an
    // arrival whose content is invisible here — it is omitted rather than hedged.
    assert.equal(/last received by this device/.test(extentBand), false, "no receipt time when records were filtered");
    assert.equal(/last updated/.test(extentBand), false, "receipt time is never presented as an update time");

    await page.click('.joined-row:has(.joined-name:text-is("Tamper Room"))');
    await page.waitForSelector("text=approved, release the funds");

    // The export is a downstream surface with no marking of its own: it scrapes the
    // rendered rows, so it inherits the attribution only because the rows carry it.
    const exported = await page.evaluate(() =>
      [...document.querySelectorAll(".shell-message")].map((row) => row.textContent?.trim() ?? "").join("\n\n")
    );
    assert.match(exported, /local copy/);
    assert.equal(/(^|\n)host/i.test(exported), false, "an exported transcript never attributes a saved line to the host");
  } finally {
    await browser?.close();
    await platform.close();
  }
});

// #276 — the top/bottom split exists so the sidebar acts as a persistent nav: the
// rooms stay reachable while a room is open, and the lower region follows the
// selection. This is the behaviour the ticket was filed to protect, so it is
// asserted rather than assumed to keep working.
test("the dashboard sidebar keeps the rooms reachable while a room is open (#276)", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, roomInput({ room_id: "alpha", title: "Alpha", status: "active" }));
  await createRoom({ root, roomId: "alpha", hostAlias: "host", briefBody: "go" });
  await createControlPlaneRoom(root, roomInput({ room_id: "beta", title: "Beta", status: "active" }));
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector(".room-row");

    // Home: rooms above, room-status guidance below.
    assert.equal(await page.locator(".rail-rooms").isVisible(), true);
    assert.equal(await page.locator("#lower-home").isVisible(), true);
    assert.equal(await page.locator("#lower-room").isVisible(), false);

    await page.click('.room-row[data-room-id="alpha"]');
    await page.waitForSelector(".platform-shell.room-selected");

    // With a room open the rooms are STILL reachable — that is the whole point of
    // the split, and losing it is what this ticket reports.
    assert.equal(await page.locator(".rail-rooms").isVisible(), true, "the rooms area must survive room selection");
    assert.equal(await page.locator('.room-row[data-room-id="beta"]').isVisible(), true, "another room stays selectable");
    // ...and the lower region now follows the selection.
    assert.equal(await page.locator("#lower-room").isVisible(), true);
    assert.equal(await page.locator("#lower-home").isVisible(), false);

    // Switching directly to the other room needs no detour home.
    await page.click('.room-row[data-room-id="beta"]');
    await page.waitForSelector('.room-row[data-room-id="beta"][aria-current="true"]');
    assert.equal(await page.locator(".rail-rooms").isVisible(), true);

    // No credential is ever in the rail markup.
    const railHtml = (await page.locator(".rail-rooms").innerHTML()) ?? "";
    assert.equal(/tgl_|Bearer|token=/i.test(railHtml), false, "the rail stays token-free");
  } finally {
    await browser.close();
    await platform.close();
  }
});
