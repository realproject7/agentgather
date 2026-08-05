// #293 — what the dashboard SHOWS for each of the three snapshot states.
//
// The three renderings are asserted exactly, because the defect being fixed is
// precisely that two of them looked identical. Every fixture is built here in a
// throwaway home; the "unreachable host" points at a port this test allocated and
// released, so nothing contacts a port it did not itself bind.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { createPlatformHttpServer } from "../src/platform/index.js";
import {
  joinedHistoryPath,
  recordJoinedHistory,
  recordJoinedRoom,
  writeSecureFile
} from "../src/storage/index.js";
import { closeServer } from "./support/close-server.js";

const DAMAGED_MARKER = "TRIPWIRE-SNAPSHOT-CONTENT-4c71";
// V8 quotes only the first ~10 bytes of the offending input, so a leak of the
// parse error shows up as this prefix rather than the whole marker.
const ECHOED_PREFIX = DAMAGED_MARKER.slice(0, 10);

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Fixture {
  root: string;
  page: Page;
  browser: Browser;
  deadUrl: string;
  close: () => Promise<void>;
}

// Two joined rooms on a host that is not listening: one under test, one healthy
// bystander so "did this break anything else" is answerable on the same screen.
async function startFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-snapshot-render-test-"));
  const deadUrl = `http://127.0.0.1:${await getFreePort()}`;
  const now = new Date(0).toISOString();
  for (const roomId of ["damaged-room", "healthy-room"]) {
    await recordJoinedRoom(root, { roomId, title: roomId, alias: "operator", baseUrl: deadUrl, joinedAt: now, lastSeen: now });
  }
  await recordJoinedHistory(root, {
    roomId: "healthy-room",
    baseUrl: deadUrl,
    savedAt: now,
    messages: [{ id: 1, from: "someone", ts: now, type: "chat", text: "healthy saved line" }]
  });

  const server = createPlatformHttpServer({ root, ownerUserId: "owner-1" });
  const port = await getFreePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForSelector('.joined-row[data-reachability="unreachable"]');
  return {
    root,
    page,
    browser,
    deadUrl,
    close: async () => {
      await browser.close();
      await closeServer(server);
    }
  };
}

// Opening a SECOND room cannot wait on `#history-source[data-source="snapshot"]`:
// that is already true from the first one, so the wait returns immediately and the
// band read back is the PREVIOUS room's. The breadcrumb is no better — it is set
// before the snapshot read resolves, so it describes the selection while the band
// is still stale. The band now carries the room it actually describes, which is
// the only signal that means "this room's view is on screen". This is the
// premature-readiness trap #248/#255/#264/#270 kept producing: waiting on a signal
// that is true earlier than the thing being asserted.
async function openRoom(page: Page, roomId: string): Promise<string> {
  await page.click(`.joined-row:has-text("${roomId}")`);
  await page.waitForSelector(`#chat-offline[data-room="${roomId}"]`);
  return (await page.locator("#chat-offline").textContent()) ?? "";
}

// Marker FIRST, so `JSON.parse` quotes it (@re2, msg 1307). A truncated-object
// fixture produces a POSITIONAL error message that names no bytes at all — a
// non-echo assertion driven by that shape cannot fail even against code that
// surfaces `error.message`, which makes it a test that guards nothing.
async function damage(root: string, deadUrl: string): Promise<void> {
  await writeSecureFile(
    joinedHistoryPath(root, { roomId: "damaged-room", baseUrl: deadUrl }),
    `${DAMAGED_MARKER} not json`
  );
}

test("an absent snapshot renders the existing 'nothing saved' band, unchanged (#293)", async () => {
  // The ordinary case for a room never opened offline: no new warning, exactly
  // as before. This is the state the damaged one used to be confused with.
  const fixture = await startFixture();
  try {
    const band = await openRoom(fixture.page, "damaged-room");
    assert.match(band, /nothing from this room is saved on this device yet/i);
    assert.equal(/cannot be read|unreadable|damaged/i.test(band), false, "absence must not warn");
    assert.equal(
      await fixture.page.locator("#history-source-label").textContent(),
      "Local snapshot · host offline"
    );
  } finally {
    await fixture.close();
  }
});

test("a valid snapshot renders its transcript, unchanged (#293)", async () => {
  const fixture = await startFixture();
  try {
    const band = await openRoom(fixture.page, "healthy-room");
    assert.match(band, /transcript saved on this device/i);
    assert.equal(/cannot be read|unreadable/i.test(band), false);
    assert.equal(await fixture.page.locator("#shell-timeline .shell-message").count(), 1);
    assert.match((await fixture.page.locator("#shell-timeline").textContent()) ?? "", /healthy saved line/);
  } finally {
    await fixture.close();
  }
});

test("a damaged snapshot renders a distinct unreadable band, not the empty state (#293)", async () => {
  const fixture = await startFixture();
  try {
    await damage(fixture.root, fixture.deadUrl);
    const band = await openRoom(fixture.page, "damaged-room");

    // The exact new rendering, and — the point of the ticket — NOT either of the
    // "nothing saved" sentences.
    assert.match(band, /saved copy of this room exists but cannot be read/i);
    assert.match(band, /cannot be rebuilt from anywhere while the host is unreachable/i);
    assert.equal(
      /nothing from this room is saved on this device yet/i.test(band),
      false,
      "a damaged copy must never read as 'nothing saved'"
    );
    assert.equal(
      await fixture.page.locator("#history-source-label").textContent(),
      "Local snapshot unreadable · host offline"
    );
    // Nothing is rendered from it: the file is unparsed data of unknown provenance.
    assert.equal(await fixture.page.locator("#shell-timeline .shell-message").count(), 0);
  } finally {
    await fixture.close();
  }
});

test("no byte of the damaged file reaches the screen (#293)", async () => {
  const fixture = await startFixture();
  try {
    await damage(fixture.root, fixture.deadUrl);
    // Positive control: the tripwire really is on disk, so its absence from the
    // page is a fact about the page rather than about the fixture.
    const onDisk = await readFile(joinedHistoryPath(fixture.root, { roomId: "damaged-room", baseUrl: fixture.deadUrl }), "utf8");
    assert.ok(onDisk.includes(DAMAGED_MARKER), "the fixture must actually contain the tripwire");

    await openRoom(fixture.page, "damaged-room");
    const rendered = await fixture.page.content();
    // Instrument check: this content genuinely produces an echoing parse error on
    // this runtime, so the absence below is a fact about the page.
    let echoed = false;
    try {
      JSON.parse(onDisk);
    } catch (error) {
      echoed = (error as Error).message.includes(ECHOED_PREFIX);
    }
    assert.ok(echoed, "the fixture must drive the byte-quoting parse shape");
    assert.equal(rendered.includes(DAMAGED_MARKER), false, "no byte of the damaged file may be shown");
    assert.equal(rendered.includes(ECHOED_PREFIX), false, "not even the quoted prefix may be shown");
    assert.equal(/Unexpected token|SyntaxError|position \d+/i.test(rendered), false, "no parse detail may be shown");
    assert.equal(rendered.includes(fixture.root), false, "no filesystem path may be shown");
  } finally {
    await fixture.close();
  }
});

test("a damaged snapshot leaves the room list and the other room's snapshot working (#293)", async () => {
  const fixture = await startFixture();
  try {
    await damage(fixture.root, fixture.deadUrl);
    const { page } = fixture;
    await openRoom(page, "damaged-room");

    // The rail still lists both rooms — one damaged snapshot is not fatal.
    assert.equal(await page.locator(".joined-row").count(), 2);
    // And the healthy room still renders its own transcript, from the same page,
    // after the damaged one was opened.
    const band = await openRoom(page, "healthy-room");
    assert.match(band, /transcript saved on this device/i);
    assert.equal(await page.locator("#shell-timeline .shell-message").count(), 1);
    assert.equal(
      await page.locator("#history-source-label").textContent(),
      "Local snapshot · host offline",
      "the healthy room must not inherit the damaged room's label"
    );
  } finally {
    await fixture.close();
  }
});

// The fourth state (@re1's P1, @re2's root fix). A failed or unrecognised read is
// "I could not check", which is not a claim about the user's data. These tests
// exist because a suite covering only absent/valid/damaged passes straight through
// the defect — which is how it survived a green run AND an approval.
test("a rejected history fetch renders 'could not check', never 'nothing saved' (#293)", async () => {
  const fixture = await startFixture();
  try {
    const { page } = fixture;
    // A transient the user hits in practice: the platform server 500s or drops.
    await page.route("**/joined-rooms/history**", (route) => route.abort("failed"));

    const band = await openRoom(page, "healthy-room");
    assert.match(band, /could not check its saved copy/i);
    assert.match(band, /transcript may still be here — try again/i);
    // The two claims it must NOT make: absence, and damage.
    assert.equal(
      /nothing from this room is saved on this device yet/i.test(band),
      false,
      "a failed read must never claim the user has no local copy"
    );
    assert.equal(
      /exists but cannot be read/i.test(band),
      false,
      "a failed read must not raise a false alarm about damage either"
    );
    assert.equal(
      await page.locator("#history-source-label").textContent(),
      "Local snapshot unavailable · host offline"
    );
    // Positive control: this room's snapshot IS intact — the fixture seeded it —
    // so "nothing saved" would have been provably false, not merely unproven.
    const onDisk = await readFile(
      joinedHistoryPath(fixture.root, { roomId: "healthy-room", baseUrl: fixture.deadUrl }),
      "utf8"
    );
    assert.ok(onDisk.includes("healthy saved line"), "the snapshot must really be intact on disk");
  } finally {
    await fixture.close();
  }
});

test("an unrecognised response state stays unknown rather than becoming absent (#293)", async () => {
  const fixture = await startFixture();
  try {
    const { page } = fixture;
    // A future server, a proxy, or a partial rollout could answer with a state
    // this client does not know. The conservative reading of unknown is unknown.
    await page.route("**/joined-rooms/history**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, snapshot: null, state: "some-future-state" })
      })
    );
    const band = await openRoom(page, "healthy-room");
    assert.match(band, /could not check its saved copy/i);
    assert.equal(/nothing from this room is saved on this device yet/i.test(band), false);
  } finally {
    await fixture.close();
  }
});

test("nothing about the failure itself reaches the screen (#293)", async () => {
  const fixture = await startFixture();
  try {
    const { page } = fixture;
    const failureMarker = "TRIPWIRE-FAILURE-DETAIL-8b2e";
    await page.route("**/joined-rooms/history**", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: failureMarker, message: `${failureMarker} at ${fixture.root}` })
      })
    );
    await openRoom(page, "healthy-room");
    const rendered = await page.content();
    // Same rule the parse error gets: report the condition, never the detail.
    assert.equal(rendered.includes(failureMarker), false, "no failure detail may be shown");
    assert.equal(rendered.includes(fixture.root), false, "no filesystem path may be shown");
    assert.equal(/\b500\b|HTTP \d{3}/.test(rendered), false, "no status code may be shown");
  } finally {
    await fixture.close();
  }
});
