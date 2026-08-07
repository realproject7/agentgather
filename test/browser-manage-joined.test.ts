// #277 — the bulk manage view for joined rooms, driven through a real browser.
//
// SAFETY: every room here is SYNTHETIC and created by this test. The list is
// seeded into a throwaway home directory, and the "unreachable" rooms point at
// ports this test allocated itself (bound, then released — nothing is listening).
// No test in this file reads a real joined-rooms list or contacts a port it did
// not itself bind. A bug in an early revision of a bulk delete would destroy rooms
// someone cares about, so the fixture is never anyone's real data.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { createPlatformHttpServer } from "../src/platform/index.js";
import { createRoomHttpServer } from "../src/server/index.js";
import { createRoom, readJoinedRooms, recordJoinedRoom, type JoinedRoom } from "../src/storage/index.js";
import { closeServer } from "./support/close-server.js";
import { captureBrowserFailure, recordBrowserDiagnostics, type BrowserDiagnostics } from "./support/browser-diagnostics.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-manage-joined-test-"));
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const UNREACHABLE_COUNT = 60;
const LIVE_COUNT = 3;
const TOTAL = UNREACHABLE_COUNT + LIVE_COUNT;

interface Fixture {
  root: string;
  baseUrl: string;
  rooms: JoinedRoom[];
  browser: Browser;
  page: Page;
  // #303: the browser is launched inside the fixture, so the recorder is created
  // here and handed back — which also covers the fixture's own 30s entry wait.
  diagnostics: BrowserDiagnostics;
  close: () => Promise<void>;
}

// Seed 63 synthetic joined rooms — the operator's reported scale — and open the
// dashboard on them. 60 point at test-owned released ports (unreachable, the
// leftovers this feature exists to clear); 3 point at one room server this test
// starts, so the reachability filter has both sides to distinguish.
async function startFixture(): Promise<Fixture> {
  const root = await makeRoot();
  const rooms: JoinedRoom[] = [];

  const deadPorts: number[] = [];
  for (let index = 0; index < 4; index += 1) deadPorts.push(await getFreePort());
  for (let index = 0; index < UNREACHABLE_COUNT; index += 1) {
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, index % 60)).toISOString();
    const room: JoinedRoom = {
      roomId: `synthetic-dead-${String(index).padStart(3, "0")}`,
      title: `Finished Work ${index}`,
      alias: "operator",
      // Reuse a small pool of test-owned ports: the store keys on (roomId,
      // baseUrl), so distinct ids on one host are distinct rows.
      baseUrl: `http://127.0.0.1:${deadPorts[index % deadPorts.length]}`,
      joinedAt: stamp,
      lastSeen: stamp
    };
    rooms.push(room);
    await recordJoinedRoom(root, room);
  }

  await createRoom({ root, roomId: "synthetic-live-room", hostAlias: "operator" });
  const roomServer = createRoomHttpServer({
    root,
    roomId: "synthetic-live-room",
    baseUrl: "http://127.0.0.1:0",
    rateLimitPerMinute: 1000
  });
  const livePort = await getFreePort();
  await new Promise<void>((resolve) => roomServer.listen(livePort, "127.0.0.1", resolve));
  const liveUrl = `http://127.0.0.1:${livePort}`;
  for (let index = 0; index < LIVE_COUNT; index += 1) {
    const stamp = new Date(Date.UTC(2026, 1, 1, 0, index)).toISOString();
    const room: JoinedRoom = {
      roomId: `synthetic-live-${index}`,
      title: `Active Room ${index}`,
      alias: "operator",
      baseUrl: liveUrl,
      joinedAt: stamp,
      lastSeen: stamp
    };
    rooms.push(room);
    await recordJoinedRoom(root, room);
  }

  const platform = createPlatformHttpServer({ root, ownerUserId: "owner-1" });
  const platformPort = await getFreePort();
  await new Promise<void>((resolve) => platform.listen(platformPort, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${platformPort}`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const diagnostics = recordBrowserDiagnostics(page, page.context());
  // This wait carries an explicit 30s ceiling and runs before any test body, so
  // an entry that never completes fails here — where, until now, nothing was
  // recorded. #277's known specimen (run 31026583592, 30961.7ms) is this shape.
  try {
    await page.goto(baseUrl);
    // Entry is complete when the manage entry point has been rendered from the
    // loaded list — not when the page merely painted.
    await page.waitForSelector("#manage-open:not([hidden])", { timeout: 30_000 });
  } catch (error) {
    await diagnostics.write("manage-joined-fixture-setup", error);
    throw error;
  }

  return {
    root,
    baseUrl,
    rooms,
    browser,
    page,
    diagnostics,
    close: async () => {
      await browser.close();
      await closeServer(platform);
      await closeServer(roomServer);
    }
  };
}

async function openManageView(page: Page): Promise<void> {
  await page.click("#manage-open");
  await page.waitForSelector("#manage:not([hidden])");
  await page.waitForFunction((expected) => document.querySelectorAll(".manage-row").length === expected, TOTAL);
}

test("the manage view renders the complete joined-room list in the main panel (#277)", async () => {
  const fixture = await startFixture();
  try {
    const { page } = fixture;
    await openManageView(page);
    // The full list, in the main panel — not the rail.
    assert.equal(await page.locator(".manage-row").count(), TOTAL);
    assert.equal(await page.locator("#manage .manage-list").count(), 1);
    assert.equal(await page.locator(".room-rail #manage-list").count(), 0);
    assert.equal(await page.locator("#manage-shown").textContent(), `${TOTAL} rooms`);
    // Token-free: no bearer token, invite URL, or card URL may reach this view's
    // markup. Scoped to the manage panel and to credential SHAPES — the rail's
    // rail's "paste an invite link" prompt is ordinary copy, not a leak, and
    // matching the bare word would make this assertion about the wrong thing.
    const markup = await page.locator("#manage").innerHTML();
    for (const pattern of [/tgl_[A-Za-z0-9]/, /Bearer\s/i, /#token=/i, /[?&]token=/i, /\/card\//i, /card_[A-Za-z0-9]/]) {
      assert.equal(pattern.test(markup), false, `manage markup must not contain ${pattern}`);
    }
    // Positive control: the assertion above is only meaningful if the markup it
    // scanned is the populated list, not an empty container.
    assert.ok(markup.includes("manage-row"), "the scanned markup must be the rendered list");
    // The API response backing this view is token-free too.
    const listed = await page.evaluate(async () => {
      const res = await fetch(new URL("./joined-rooms", document.baseURI));
      return res.text();
    });
    assert.equal(/tgl_[A-Za-z0-9]|Bearer\s|"token"/i.test(listed), false, "the backing response must be token-free");
    assert.ok(listed.includes("synthetic-dead-000"), "positive control: the response really is the room list");
  } catch (error) {
    await fixture.diagnostics.write("the-manage-view-renders-the-complete-joined-room", error);
    throw error;
  } finally {
    await fixture.close();
  }
});

test("select-all shows an indeterminate state on partial selection and a live count (#277)", async () => {
  const fixture = await startFixture();
  try {
    const { page } = fixture;
    await openManageView(page);
    const selectAll = page.locator("#manage-select-all");
    assert.equal(await page.locator("#manage-count").textContent(), "0 selected");
    assert.equal(await selectAll.evaluate((el: HTMLInputElement) => el.indeterminate), false);

    // One row ticked → strict non-empty subset → indeterminate.
    await page.locator(".manage-row .manage-check").first().check();
    assert.equal(await page.locator("#manage-count").textContent(), "1 selected");
    assert.equal(await selectAll.evaluate((el: HTMLInputElement) => el.indeterminate), true);
    assert.equal(await selectAll.evaluate((el: HTMLInputElement) => el.checked), false);

    // Select all → checked, not indeterminate, count equals the shown rows.
    await selectAll.check();
    assert.equal(await page.locator("#manage-count").textContent(), `${TOTAL} selected`);
    assert.equal(await selectAll.evaluate((el: HTMLInputElement) => el.indeterminate), false);
    assert.equal(await page.locator(".manage-check:checked").count(), TOTAL);

    // Unticking one row from a full selection returns to indeterminate.
    await page.locator(".manage-row .manage-check").first().uncheck();
    assert.equal(await page.locator("#manage-count").textContent(), `${TOTAL - 1} selected`);
    assert.equal(await selectAll.evaluate((el: HTMLInputElement) => el.indeterminate), true);
  } catch (error) {
    await fixture.diagnostics.write("select-all-shows-an-indeterminate-state-on-parti", error);
    throw error;
  } finally {
    await fixture.close();
  }
});

test("bulk delete removes exactly the selected rooms and leaves every other row present and unchanged (#277)", async () => {
  const fixture = await startFixture();
  try {
    const { page, root } = fixture;
    const before = await readJoinedRooms(root);
    assert.equal(before.length, TOTAL);
    await openManageView(page);

    // A scattered subset of five rows, chosen by their rendered keys so the
    // assertion below is about the rooms the user actually ticked.
    const keys = await page.locator(".manage-row").evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.key ?? "")
    );
    const chosen = [keys[2], keys[9], keys[17], keys[30], keys[44]].filter((key): key is string => Boolean(key));
    assert.equal(chosen.length, 5);
    for (const key of chosen) await page.locator(`.manage-row[data-key="${key}"] .manage-check`).check();
    assert.equal(await page.locator("#manage-count").textContent(), "5 selected");

    // Delete is gated: the first click only opens a confirmation that NAMES the
    // count, and the store must still be intact at that point.
    await page.click("#manage-delete");
    await page.waitForSelector("#manage-confirm:not([hidden])");
    const confirmText = (await page.locator("#manage-confirm-msg").textContent()) ?? "";
    assert.match(confirmText, /Delete 5 rooms from this device\?/);
    assert.equal((await readJoinedRooms(root)).length, TOTAL, "opening the confirm must not delete anything");

    await page.click("#manage-confirm-delete");
    await page.waitForFunction((expected) => document.querySelectorAll(".manage-row").length === expected, TOTAL - 5);

    const after = await readJoinedRooms(root);
    const chosenKeys = new Set(chosen);
    const keyOf = (room: JoinedRoom): string => `${room.roomId.length}:${room.roomId}|${room.baseUrl}`;
    assert.equal(after.length, TOTAL - 5);
    for (const room of after) {
      assert.equal(chosenKeys.has(keyOf(room)), false, `${room.roomId} was selected and must be gone`);
    }
    // The invariant the ticket demands: every UNSELECTED row is still present and
    // unchanged. "The selected ones are gone" alone would also hold if the call
    // had wiped the entire store.
    const survivors = before.filter((room) => !chosenKeys.has(keyOf(room)));
    assert.deepEqual(after, survivors);
  } catch (error) {
    await fixture.diagnostics.write("bulk-delete-removes-exactly-the-selected-rooms-a", error);
    throw error;
  } finally {
    await fixture.close();
  }
});

test("bulk archive applies to the selection only and keeps the rows (#277)", async () => {
  const fixture = await startFixture();
  try {
    const { page, root } = fixture;
    await openManageView(page);
    const keys = await page.locator(".manage-row").evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.key ?? "")
    );
    const chosen = [keys[1], keys[5], keys[11]].filter((key): key is string => Boolean(key));
    for (const key of chosen) await page.locator(`.manage-row[data-key="${key}"] .manage-check`).check();

    await page.click("#manage-archive");
    await page.waitForFunction(
      (expected) => document.querySelectorAll('.manage-row[data-archived="true"]').length === expected,
      chosen.length
    );

    const after = await readJoinedRooms(root);
    assert.equal(after.length, TOTAL, "archive must not remove rows");
    const chosenKeys = new Set(chosen);
    const keyOf = (room: JoinedRoom): string => `${room.roomId.length}:${room.roomId}|${room.baseUrl}`;
    for (const room of after) {
      if (chosenKeys.has(keyOf(room))) assert.equal(room.archived, true);
      else assert.equal("archived" in room, false, `${room.roomId} was not selected and must be untouched`);
    }
  } catch (error) {
    await fixture.diagnostics.write("bulk-archive-applies-to-the-selection-only-and-k", error);
    throw error;
  } finally {
    await fixture.close();
  }
});

test("filters narrow the list, and select-all covers only the rows shown (#277)", async () => {
  const fixture = await startFixture();
  try {
    const { page } = fixture;
    await openManageView(page);

    await page.selectOption("#manage-filter-reach", "unreachable");
    await page.waitForFunction(
      (expected) => document.querySelectorAll(".manage-row").length === expected,
      UNREACHABLE_COUNT
    );
    assert.equal(await page.locator('.manage-row[data-reachability="live"]').count(), 0);

    await page.selectOption("#manage-filter-reach", "reachable");
    await page.waitForFunction((expected) => document.querySelectorAll(".manage-row").length === expected, LIVE_COUNT);
    // Select-all under a filter must cover exactly the visible rows — never the
    // filtered-out ones, which the user cannot see.
    await page.locator("#manage-select-all").check();
    assert.equal(await page.locator("#manage-count").textContent(), `${LIVE_COUNT} selected`);

    // Widening the filter must not silently retain a selection made under it.
    await page.selectOption("#manage-filter-reach", "all");
    await page.waitForFunction((expected) => document.querySelectorAll(".manage-row").length === expected, TOTAL);
    assert.equal(await page.locator("#manage-count").textContent(), `${LIVE_COUNT} selected`);

    await page.selectOption("#manage-filter-archived", "archived");
    await page.waitForFunction(() => document.querySelectorAll(".manage-row").length === 0);
    assert.equal(await page.locator("#manage-empty").isVisible(), true);
    // With nothing shown, nothing can be selected — so no action can fire.
    assert.equal(await page.locator("#manage-count").textContent(), "0 selected");
    assert.equal(await page.locator("#manage-delete").isDisabled(), true);
  } catch (error) {
    await fixture.diagnostics.write("filters-narrow-the-list-and-select-all-covers-on", error);
    throw error;
  } finally {
    await fixture.close();
  }
});

test("the manage view does not overflow horizontally at 1280 or 390 (#277)", async () => {
  const fixture = await startFixture();
  try {
    const { page } = fixture;
    await openManageView(page);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction((expected) => window.innerWidth === expected, width);
      const overflow = await page.evaluate(() => ({
        body: document.body.scrollWidth - document.body.clientWidth,
        panel: (() => {
          const panel = document.getElementById("manage");
          return panel === null ? 0 : panel.scrollWidth - panel.clientWidth;
        })()
      }));
      assert.ok(overflow.body <= 1, `body overflows by ${overflow.body}px at ${width}`);
      assert.ok(overflow.panel <= 1, `manage panel overflows by ${overflow.panel}px at ${width}`);
    }
  } catch (error) {
    await fixture.diagnostics.write("the-manage-view-does-not-overflow-horizontally-a", error);
    throw error;
  } finally {
    await fixture.close();
  }
});

// A mixed selection spans two device-local stores: joined-rooms.json (platform,
// via the loopback API) and this browser's localStorage. The tests below drive
// the failure of each half and assert the other half did not half-apply — the
// case @re1 raised on PR #282.
const LOCAL_KEY = "agentgather.joinedRooms";

interface LocalRoom {
  roomId: string;
  title: string;
  alias: string;
  baseUrl: string;
  joinedAt: string;
  lastSeen: string;
}

function localRooms(count: number, port: number): LocalRoom[] {
  return Array.from({ length: count }, (_value, index) => ({
    roomId: `synthetic-local-${index}`,
    title: `Browser Room ${index}`,
    alias: "operator",
    baseUrl: `http://127.0.0.1:${port}/local-${index}`,
    joinedAt: new Date(Date.UTC(2026, 2, 1, 0, index)).toISOString(),
    lastSeen: new Date(Date.UTC(2026, 2, 1, 0, index)).toISOString()
  }));
}

// Seed browser-owned rows into localStorage before the shell boots, so the manage
// view holds a genuinely mixed selection.
async function startMixedFixture(localCount: number): Promise<Fixture & { local: LocalRoom[] }> {
  const fixture = await startFixture();
  const local = localRooms(localCount, await getFreePort());
  // #303 (@re2, PR #304): the reload below re-runs entry and waits on a 30s
  // ceiling, and every caller invokes this helper BEFORE its own try — so a
  // timeout here reached no catch and left nothing behind. The recorder is
  // already live on this page, so this recovers a real trace rather than an
  // accounting entry.
  try {
    await fixture.page.evaluate(
      ([key, rooms]) => window.localStorage.setItem(key as string, JSON.stringify({ rooms })),
      [LOCAL_KEY, local] as const
    );
    await fixture.page.reload();
    await fixture.page.waitForSelector("#manage-open:not([hidden])", { timeout: 30_000 });
  } catch (error) {
    await captureBrowserFailure(fixture.diagnostics, "manage-joined-mixed-fixture-setup", error);
    throw error;
  }
  return { ...fixture, local };
}

async function readLocalRooms(page: Page): Promise<LocalRoom[]> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key as string);
    return raw === null ? [] : ((JSON.parse(raw) as { rooms: LocalRoom[] }).rooms ?? []);
  }, LOCAL_KEY);
}

test("a failed platform write leaves the browser-local half applied and SAYS so, per store (#277)", async () => {
  // Per the operator ruling (msg 1246): the two device-local stores are applied
  // independently and reported per store. This is deliberately NOT atomic across
  // them — what it must never be is silent.
  const fixture = await startMixedFixture(4);
  try {
    const { page, root } = fixture;
    const before = await readJoinedRooms(root);

    await page.click("#manage-open");
    await page.waitForSelector("#manage:not([hidden])");
    await page.waitForFunction((expected) => document.querySelectorAll(".manage-row").length === expected, TOTAL + 4);

    await page.route("**/joined-rooms/delete-bulk", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, message: "storage unavailable" })
      })
    );

    await page.locator("#manage-select-all").check();
    await page.click("#manage-delete");
    await page.waitForSelector("#manage-confirm:not([hidden])");
    await page.click("#manage-confirm-delete");
    await page.waitForSelector("#manage-error:not([hidden])");

    // The message must name what actually happened on each store — a count that
    // went and a count that did not — rather than a bare failure.
    const message = (await page.locator("#manage-error").textContent()) ?? "";
    assert.match(message, /Deleted 4 rooms\./, `message must report the store that committed, got: ${message}`);
    assert.match(message, new RegExp(`${TOTAL} rooms could not be deleted`), `message must report the failure count, got: ${message}`);

    // The platform store is untouched, and the browser-local rows really were
    // removed — the honest partial the message describes.
    assert.deepEqual(await readJoinedRooms(root), before, "the platform store must be untouched");
    assert.deepEqual(await readLocalRooms(page), [], "the browser-local half committed, as reported");
  } catch (error) {
    await fixture.diagnostics.write("a-failed-platform-write-leaves-the-browser-local", error);
    throw error;
  } finally {
    await fixture.close();
  }
});

test("a failed browser-local write is reported rather than swallowed (#277)", async () => {
  // The pre-review code called the forgiving writeJoinedLocal(), whose catch
  // swallows a quota failure outright: the platform rows went, the browser rows
  // silently did not, and nothing was shown. That silence is the defect.
  const fixture = await startMixedFixture(3);
  try {
    const { page, root } = fixture;
    await page.evaluate(() => {
      window.localStorage.setItem = () => {
        throw new Error("QuotaExceededError");
      };
    });

    await page.click("#manage-open");
    await page.waitForSelector("#manage:not([hidden])");
    await page.locator("#manage-select-all").check();
    await page.click("#manage-delete");
    await page.waitForSelector("#manage-confirm:not([hidden])");
    await page.click("#manage-confirm-delete");
    await page.waitForSelector("#manage-error:not([hidden])");

    const message = (await page.locator("#manage-error").textContent()) ?? "";
    assert.match(message, /3 rooms this browser remembers could not be deleted/, `got: ${message}`);
    assert.match(message, new RegExp(`Deleted ${TOTAL} rooms\\.`), `got: ${message}`);
    // The platform half did commit, exactly as the message says.
    assert.equal((await readJoinedRooms(root)).length, 0);
  } catch (error) {
    await fixture.diagnostics.write("a-failed-browser-local-write-is-reported-rather", error);
    throw error;
  } finally {
    await fixture.close();
  }
});

test("a platform-only selection still commits normally when no browser rows are involved (#277)", async () => {
  // Guards against the rollback path making the ordinary case conditional on a
  // browser-local store that most selections never touch.
  const fixture = await startMixedFixture(2);
  try {
    const { page, root } = fixture;
    // Captured BEFORE the action: comparing the browser-local list to a reading
    // of itself taken after would hold no matter what the archive did.
    const localBefore = await readLocalRooms(page);
    assert.equal(localBefore.length, 2, "positive control: the browser-local rows must be seeded");
    await page.click("#manage-open");
    await page.waitForSelector("#manage:not([hidden])");
    await page.waitForFunction((expected) => document.querySelectorAll(".manage-row").length === expected, TOTAL + 2);

    const keys = await page.locator(".manage-row").evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.key ?? "")
    );
    // Rows whose key names a platform-seeded room only.
    const platformKeys = keys.filter((key) => key.includes("synthetic-dead-")).slice(0, 3);
    assert.equal(platformKeys.length, 3);
    for (const key of platformKeys) await page.locator(`.manage-row[data-key="${key}"] .manage-check`).check();

    await page.click("#manage-archive");
    await page.waitForFunction(
      (expected) => document.querySelectorAll('.manage-row[data-archived="true"]').length === expected,
      3
    );
    const after = await readJoinedRooms(root);
    assert.equal(after.filter((room) => room.archived === true).length, 3);
    assert.equal(after.length, TOTAL, "archive must not remove rows");
    // A platform-only selection must leave the browser-owned store untouched —
    // same rows, same contents, including the absence of `archived`.
    assert.deepEqual(await readLocalRooms(page), localBefore, "browser-local rows must be untouched");
  } catch (error) {
    await fixture.diagnostics.write("a-platform-only-selection-still-commits-normally", error);
    throw error;
  } finally {
    await fixture.close();
  }
});
