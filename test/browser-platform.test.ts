import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import type { Participant } from "../src/protocol/index.js";
import { createPlatformHttpServer, createControlPlaneRoom } from "../src/platform/index.js";
import { appendServerMessage, createRoom, writeParticipants } from "../src/storage/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
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
  const js = await readFile(new URL("../src/browser/shell.js", import.meta.url), "utf8");
  assert.match(html, /shell.css/);
  assert.match(css, /platform-shell/);
  assert.match(css, /color-scheme: dark/);
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

test("owner shell shows an empty state when the owner has no rooms", async () => {
  const root = await makeRoot();
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(platform.baseUrl);
    await page.waitForSelector("text=No rooms yet.");
    assert.equal(await page.locator(".room-row").count(), 0);
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
