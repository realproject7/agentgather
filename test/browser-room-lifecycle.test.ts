import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Page } from "playwright";
import type { Participant } from "../src/protocol/index.js";
import { createRoom, writeParticipants } from "../src/storage/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";

// #241 room-entry lifecycle: token-fragment entry must be idempotent (post-entry
// AND while the joining interstitial is shown), and a terminal (closed) room must
// load its history once and stop all polling.

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

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Fixture {
  baseUrl: string;
  hostToken: string;
  joinerToken: string;
  close: () => Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-lifecycle-test-"));
  const roomId = `life-${Math.random().toString(36).slice(2, 10)}`;
  const hostToken = `host-${roomId}`;
  const joinerToken = `joiner-${roomId}`;
  await createRoom({ root, roomId, hostAlias: "host", briefBody: "Lifecycle room." });
  await writeParticipants(root, roomId, [
    { ...participant("host", "human", true, hostToken), display_name: "Host" },
    // A human with NO display_name and non-host → lands on the joining interstitial.
    participant("joiner", "human", false, joinerToken)
  ]);
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createRoomHttpServer({ root, roomId, baseUrl, rateLimitPerMinute: 1_000 });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    baseUrl,
    hostToken,
    joinerToken,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  };
}

interface Counters {
  messagePolls: number;
  messagePosts: number;
  profileClaims: number;
  statusPolls: number;
  // GET /brief runs once per enterRoom (and nowhere else in these flows), so it is
  // a deterministic count of how many times entry ran.
  briefLoads: number;
}

function countRequests(page: Page): Counters {
  const counters: Counters = {
    messagePolls: 0,
    messagePosts: 0,
    profileClaims: 0,
    statusPolls: 0,
    briefLoads: 0
  };
  page.on("request", (req) => {
    const url = req.url();
    const method = req.method();
    if (url.includes("/messages")) {
      if (method === "POST") counters.messagePosts += 1;
      else if (method === "GET") counters.messagePolls += 1;
    } else if (url.includes("/profile") && method === "POST") {
      counters.profileClaims += 1;
    } else if (url.includes("/status") && method === "GET") {
      counters.statusPolls += 1;
    } else if (url.includes("/brief") && method === "GET") {
      counters.briefLoads += 1;
    }
  });
  return counters;
}

// Land on the unauthenticated page so the hashchange re-entry listener is armed;
// a later `#token=` fragment is what drives startWithToken (the re-entry path).
async function gotoUnauthenticated(page: Page, fixture: Fixture): Promise<void> {
  await page.goto(`${fixture.baseUrl}/`);
  await page.waitForSelector('.room-shell[data-state="auth-error"]');
}

// tokenFromFragment clears the hash after reading it, so re-setting the same
// fragment always fires a fresh hashchange — this is the later token-fragment.
async function deliverToken(page: Page, token: string): Promise<void> {
  await page.evaluate((value) => {
    window.location.hash = `token=${value}`;
  }, token);
}

test("a later token-fragment re-entry after entering does not duplicate handlers or timers", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const counters = countRequests(page);
    await gotoUnauthenticated(page, fixture);

    await deliverToken(page, fixture.hostToken);
    await page.waitForSelector("text=Lifecycle room."); // entered

    // A second token fragment arrives after entry — must be ignored (no re-entry).
    // Wait long enough that an unguarded second enterRoom would have fully re-run
    // (its brief/status/messages fetches + a second bindEvents) before we send.
    await deliverToken(page, fixture.hostToken);
    await page.waitForTimeout(2_500);

    // enterRoom ran exactly once: GET /brief (only called from enterRoom here) is 1.
    // A second, unguarded enterRoom would have loaded the brief again.
    assert.equal(counters.briefLoads, 1, "entry (and its bindEvents/timers) ran exactly once");

    // And sending still posts exactly once (single composer submit handler).
    await page.fill("#message-text", "hello exactly once");
    await page.click("#send-button");
    await page.waitForSelector("text=hello exactly once");
    await page.waitForTimeout(300);
    assert.equal(counters.messagePosts, 1, "one send handler");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("a token-fragment re-entry while the joining interstitial is shown claims and enters once", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const counters = countRequests(page);
    await gotoUnauthenticated(page, fixture);

    await deliverToken(page, fixture.joinerToken);
    await page.waitForSelector('.room-shell[data-state="joining"]');
    await page.waitForSelector("#join-panel:not([hidden])");

    // A second fragment while the interstitial is up — must not re-bind the join
    // form (which would submit twice on one Enter/click).
    await deliverToken(page, fixture.joinerToken);
    await page.waitForTimeout(400);

    await page.fill("#display-name", "Joiner Name");
    await page.click("#join-button");
    await page.waitForSelector("text=Lifecycle room."); // entered
    await page.waitForTimeout(300);

    assert.equal(counters.profileClaims, 1, "claimDisplayName fired exactly once");
    // Entry side effects ran once: sending still posts exactly once.
    await page.fill("#message-text", "joined once");
    await page.click("#send-button");
    await page.waitForSelector("text=joined once");
    await page.waitForTimeout(300);
    assert.equal(counters.messagePosts, 1, "entered exactly once");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("a closed room loads its final history once and stops all polling timers", async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const counters = countRequests(page);

    // Host enters directly (open room), so poll + status timers are running.
    await page.goto(`${fixture.baseUrl}/#token=${fixture.hostToken}`);
    await page.waitForSelector("text=Lifecycle room.");
    await page.waitForTimeout(1_500); // let a poll or two happen while open

    // Close the room; the next poll loads final history once, then timers clear.
    await page.click("#close-button");
    await page.waitForSelector('#room-status[data-status="closed"]');

    // Give the finalize poll time to run and clear the timers.
    await page.waitForTimeout(6_000);
    const settled: Counters = { ...counters };

    // With timers cleared, a further window sees zero new polls. Live timers would
    // add ~2 message polls (3s) + ~1 status poll (5s) here.
    await page.waitForTimeout(6_000);
    assert.equal(counters.messagePolls, settled.messagePolls, "no message poll after closure");
    assert.equal(counters.statusPolls, settled.statusPolls, "no status poll after closure");
  } finally {
    await browser.close();
    await fixture.close();
  }
});
