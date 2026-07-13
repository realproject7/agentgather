import assert from "node:assert/strict";
import { AddressInfo, createServer as createNetServer } from "node:net";
import type { Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import type { CliContext } from "../src/cli/context.js";
import { runLaunchCommand } from "../src/cli/commands/launch/index.js";
import { createControlPlaneRoom } from "../src/platform/index.js";
import { VERSION } from "../src/cli/help.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-browser-launch-"));
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function makeCtx(home: string): CliContext {
  return { home, stdout: { write: () => true }, stderr: { write: () => true } } as unknown as CliContext;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Browser smoke: the exact localhost URL the launcher hands to the browser opener
// renders the existing owner dashboard at desktop width, with no horizontal
// overflow. The launcher-started server is kept alive through the shutdown hook
// until the browser assertions finish.
test("the launcher's opened URL renders the existing dashboard at desktop width (#232)", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, {
    room_id: "alpha",
    title: "Alpha Room",
    owner_user_id: "local-owner",
    route_url: "https://rooms.agentgather.dev/alpha",
    status: "active",
    roster: [{ alias: "host", kind: "human", role: "host", status: "attending" }],
    route_health: { reachable: true, host_connected: true },
    last_synced_message_id: 0
  });

  const port = await getFreePort();
  let openedUrl = "";
  let releaseServer = (): void => {};
  const shutdownGate = new Promise<void>((resolve) => {
    releaseServer = resolve;
  });

  const launch = runLaunchCommand(["--port", String(port)], makeCtx(root), {
    probeVersion: async () => "absent",
    openBrowser: async (url) => {
      openedUrl = url;
      return true;
    },
    waitForShutdown: async (server: Server) => {
      await shutdownGate;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const browser = await chromium.launch();
  try {
    await waitFor(() => openedUrl !== "", 15_000);
    assert.equal(openedUrl, `http://127.0.0.1:${port}`);

    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(openedUrl);
    await page.waitForSelector('.platform-shell[data-view="rooms"]');
    await page.waitForSelector(".room-row");
    await page.waitForSelector("#platform-version-value");
    assert.equal(await page.locator("#platform-version-value").textContent(), `v${VERSION}`);

    // Desktop width renders without horizontal overflow.
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert.equal(noHScroll, true, "dashboard overflowed horizontally at desktop width");
  } finally {
    await browser.close();
    releaseServer();
    await launch;
  }
});
