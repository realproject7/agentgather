// #275 — the resizable sidebar split.
//
// Every size assertion here is an EXACT expected pixel value, not "something
// changed": a drag or arrow press that moves the boundary to the wrong place
// would satisfy a change-only assertion just as well as the right one.
//
// The stored split is treated as untrusted input, so the clamp cases below feed
// the values that actually turn up in localStorage — junk, negatives, NaN, and a
// value saved in a much taller window.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { createControlPlaneRoom, createPlatformHttpServer } from "../src/platform/index.js";
import { closeServer } from "./support/close-server.js";

const SPLIT_KEY = "agentgather.railSplit";
const MIN_TOP = 120;
const MIN_BOTTOM = 120;
const STEP = 16;
const STEP_LARGE = 64;

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Fixture {
  page: Page;
  browser: Browser;
  baseUrl: string;
  close: () => Promise<void>;
}

// The shell only lays the rail out once it has a room, so the fixture seeds one.
// `storedSplit` is written before the first load, which is the only way to
// exercise the read path the way a returning user hits it.
async function startFixture(
  storedSplit?: string,
  viewport: { width: number; height: number } = { width: 1280, height: 900 }
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-rail-resize-test-"));
  await createControlPlaneRoom(root, {
    room_id: "rail-fixture-room",
    title: "Rail Fixture",
    owner_user_id: "owner-1",
    route_url: "https://rooms.agentgather.dev/room",
    status: "active",
    roster: [{ alias: "host", kind: "human", role: "host", status: "attending" }],
    route_health: { reachable: true, host_connected: true },
    last_synced_message_id: 0
  } as Parameters<typeof createControlPlaneRoom>[1]);
  const server = createPlatformHttpServer({ root, ownerUserId: "owner-1" });
  const port = await getFreePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport });
  if (storedSplit !== undefined) {
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      [SPLIT_KEY, storedSplit] as const
    );
  }
  await page.goto(baseUrl);
  // Readiness is the shell's own ready state, not first paint: the rail has no
  // height while the loading view is up, and measuring then reports the layout
  // that exists before any stored split can be applied.
  await page.waitForSelector('.platform-shell[data-state="ready"]');
  if (viewport.width >= 860) {
    await page.waitForFunction(() => (document.querySelector(".room-rail") as HTMLElement | null)?.clientHeight! > 0);
  }
  // No further waiting: the shell binds the divider and restores the stored split
  // BEFORE it sets `data-state="ready"`, so that flag already means the restore
  // has happened or has been rejected. Polling for a split with a timeout would
  // be a fixed sleep guarding an absence — it would "prove" a junk value was
  // rejected simply by giving up.
  return {
    page,
    browser,
    baseUrl,
    close: async () => {
      await browser.close();
      await closeServer(server);
    }
  };
}

async function roomsHeight(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(document.querySelector(".rail-rooms")!.getBoundingClientRect().height));
}

// The rail's budget for the upper region: its height less every child that is
// not one of the two resizable regions (the divider AND the version footer), less
// the lower region's minimum. Computed here the same way the product does, so the
// expected value is derived from the layout rather than hardcoded to one viewport.
async function maxTop(page: Page): Promise<number> {
  return page.evaluate((minBottom) => {
    const rail = document.querySelector(".room-rail") as HTMLElement;
    const rooms = document.querySelector(".rail-rooms") as HTMLElement;
    const lower = document.querySelector(".rail-lower") as HTMLElement;
    let reserved = 0;
    for (const child of rail.children) {
      if (child === rooms || child === lower) continue;
      reserved += child.getBoundingClientRect().height;
    }
    return Math.floor(rail.clientHeight - reserved - (minBottom as number));
  }, MIN_BOTTOM);
}

test("the divider is a named, oriented separator that is reachable by keyboard (#275)", async () => {
  const fixture = await startFixture();
  try {
    const { page } = fixture;
    const divider = page.locator("#rail-divider");
    assert.equal(await divider.getAttribute("role"), "separator");
    assert.equal(await divider.getAttribute("aria-orientation"), "horizontal");

    // The name must READ correctly, not merely exist. An empty or filler label
    // satisfies "has an aria-label" and tells a screen-reader user nothing.
    const name = (await divider.getAttribute("aria-label")) ?? "";
    assert.equal(name, "Resize the rooms list");
    assert.ok(name.trim().length > 0);

    // A focusable separator is a window splitter: without value attributes it is
    // operable but not perceivable — arrows move a boundary the user cannot hear.
    // These must be present BEFORE any interaction, which is when they matter
    // most, and aria-valuenow must describe the real starting layout.
    const startingHeight = await roomsHeight(page);
    assert.equal(await divider.getAttribute("aria-valuenow"), String(startingHeight));
    assert.equal(await divider.getAttribute("aria-valuemin"), String(MIN_TOP));
    assert.equal(await divider.getAttribute("aria-valuemax"), String(await maxTop(page)));

    // Reached by real Tab presses, not by scripted focus.
    let reached = false;
    for (let press = 0; press < 40; press += 1) {
      await page.keyboard.press("Tab");
      if ((await page.evaluate(() => document.activeElement?.id ?? "")) === "rail-divider") {
        reached = true;
        break;
      }
    }
    assert.ok(reached, "the divider must be reachable by tabbing");

    // Visible focus state, with a positive control that it belongs to focus.
    const focused = await divider.evaluate((el) => window.getComputedStyle(el).outlineStyle);
    assert.notEqual(focused, "none", "the focused divider must show an outline");
    await page.locator(".rail-rooms").click();
    const blurred = await divider.evaluate((el) => window.getComputedStyle(el).outlineStyle);
    assert.equal(blurred, "none", "the outline must belong to the focus state");
  } finally {
    await fixture.close();
  }
});

test("arrow keys move the split by an exact step, and Shift by the large step (#275)", async () => {
  const fixture = await startFixture("300");
  try {
    const { page } = fixture;
    assert.equal(await roomsHeight(page), 300, "the stored split must be applied exactly");

    await page.locator("#rail-divider").focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await roomsHeight(page), 300 + STEP);
    await page.keyboard.press("ArrowUp");
    assert.equal(await roomsHeight(page), 300);
    await page.keyboard.press("ArrowUp");
    assert.equal(await roomsHeight(page), 300 - STEP);

    await page.keyboard.press("Shift+ArrowDown");
    assert.equal(await roomsHeight(page), 300 - STEP + STEP_LARGE);

    // aria-valuenow tracks the live split rather than being set once.
    assert.equal(
      await page.locator("#rail-divider").getAttribute("aria-valuenow"),
      String(300 - STEP + STEP_LARGE)
    );
    assert.equal(await page.locator("#rail-divider").getAttribute("aria-valuemin"), String(MIN_TOP));
  } finally {
    await fixture.close();
  }
});

test("dragging the divider moves the boundary to exactly the pointer position (#275)", async () => {
  const fixture = await startFixture("300");
  try {
    const { page } = fixture;
    const railTop = await page.evaluate(() => document.querySelector(".room-rail")!.getBoundingClientRect().top);
    const divider = page.locator("#rail-divider");
    const box = await divider.boundingBox();
    assert.ok(box !== null);

    // Drag to an absolute Y. The upper region is then exactly the distance from
    // the rail's top to the pointer — an exact expected number, not "taller".
    const targetY = railTop + 420;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, targetY, { steps: 8 });
    await page.mouse.up();
    assert.equal(await roomsHeight(page), 420);

    // And it persisted the settled value, not the value it started from.
    assert.equal(await page.evaluate((key) => window.localStorage.getItem(key as string), SPLIT_KEY), "420");
  } finally {
    await fixture.close();
  }
});

test("neither region can be dragged below its minimum (#275)", async () => {
  const fixture = await startFixture("300");
  try {
    const { page } = fixture;
    const railTop = await page.evaluate(() => document.querySelector(".room-rail")!.getBoundingClientRect().top);
    const box = await page.locator("#rail-divider").boundingBox();
    assert.ok(box !== null);
    const expectedMax = await maxTop(page);

    // Drag far above the rail: the upper region stops at its minimum exactly.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, railTop - 500, { steps: 8 });
    await page.mouse.up();
    assert.equal(await roomsHeight(page), MIN_TOP);

    // Drag far below it: the LOWER region keeps its minimum, so the upper stops
    // at the computed maximum exactly.
    const box2 = await page.locator("#rail-divider").boundingBox();
    assert.ok(box2 !== null);
    await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await page.mouse.down();
    await page.mouse.move(box2.x + box2.width / 2, railTop + 5000, { steps: 8 });
    await page.mouse.up();
    assert.equal(await roomsHeight(page), expectedMax);

    // Both regions are still usable — neither collapsed.
    const lower = await page.evaluate(() =>
      Math.round(document.querySelector(".rail-lower")!.getBoundingClientRect().height)
    );
    assert.ok(lower >= MIN_BOTTOM, `lower region collapsed to ${lower}`);
  } finally {
    await fixture.close();
  }
});

test("keyboard resizing also stops at the minimums (#275)", async () => {
  const fixture = await startFixture("300");
  try {
    const { page } = fixture;
    const expectedMax = await maxTop(page);
    await page.locator("#rail-divider").focus();
    // Home/End are the fast path to each bound; assert the exact bound, not a
    // direction of travel.
    await page.keyboard.press("Home");
    assert.equal(await roomsHeight(page), MIN_TOP);
    await page.keyboard.press("ArrowUp");
    assert.equal(await roomsHeight(page), MIN_TOP, "already at the minimum, so it must not move further");
    await page.keyboard.press("End");
    assert.equal(await roomsHeight(page), expectedMax);
    await page.keyboard.press("ArrowDown");
    assert.equal(await roomsHeight(page), expectedMax, "already at the maximum, so it must not move further");
  } finally {
    await fixture.close();
  }
});

test("the split survives a reload on the same device, at exactly the chosen size (#275)", async () => {
  const fixture = await startFixture();
  try {
    const { page } = fixture;
    const before = await roomsHeight(page);
    await page.locator("#rail-divider").focus();
    await page.keyboard.press("ArrowDown");
    const chosen = await roomsHeight(page);
    assert.equal(chosen, before + STEP, "the first arrow press must move from the measured starting height");

    await page.reload();
    await page.waitForSelector('.platform-shell[data-state="ready"]');
    await page.waitForFunction(
      (expected) =>
        Math.round(document.querySelector(".rail-rooms")!.getBoundingClientRect().height) === (expected as number),
      chosen
    );
    assert.equal(await roomsHeight(page), chosen, "the reloaded split must be the exact size chosen");
    assert.equal(await page.evaluate((key) => window.localStorage.getItem(key as string), SPLIT_KEY), String(chosen));
  } finally {
    await fixture.close();
  }
});

test("an out-of-range stored split is clamped on READ, not trusted (#275)", async () => {
  // Saved in a much taller window, then reopened in a short one. The clamp has to
  // happen on the way in; validating only on write would let this collapse the
  // lower region to nothing.
  const fixture = await startFixture("99999");
  try {
    const { page } = fixture;
    const expectedMax = await maxTop(page);
    assert.equal(await roomsHeight(page), expectedMax, "an oversized stored split must clamp to the maximum");
    const lower = await page.evaluate(() =>
      Math.round(document.querySelector(".rail-lower")!.getBoundingClientRect().height)
    );
    assert.ok(lower >= MIN_BOTTOM, `lower region collapsed to ${lower} from a stored value`);
  } finally {
    await fixture.close();
  }
});

test("a negative stored split cannot collapse the rooms list (#275)", async () => {
  const fixture = await startFixture("-4000");
  try {
    const { page } = fixture;
    assert.equal(await roomsHeight(page), MIN_TOP, "a negative stored split must clamp to the minimum");
  } finally {
    await fixture.close();
  }
});

test("non-numeric stored values are discarded and the default layout is kept (#275)", async () => {
  // This is an ABSENCE assertion — "no split was applied" — so it carries both
  // controls. Without them, a page that failed to boot at all would look
  // identical to one that correctly rejected the value.
  // "" and "   " are in this list on purpose: `Number("")` is 0, so a validator
  // built on Number() alone would turn an empty entry into a real split rather
  // than rejecting it. "0x80" is here for the same reason.
  for (const junk of ["not-a-number", "", "   ", "NaN", "Infinity", "null", "undefined", "0x80", '{"top":300}']) {
    const fixture = await startFixture(junk);
    try {
      const { page } = fixture;
      // NEGATIVE control: the junk value must leave no split applied.
      const applied = await page.evaluate(() => (document.querySelector(".room-rail") as HTMLElement).dataset.split);
      assert.equal(applied, undefined, `"${junk}" must not be applied as a split`);
      // POSITIVE control on the same instrument: the page really did boot and the
      // rail really is laid out, so "no split" is a rejection rather than a
      // failure to render.
      assert.ok(await roomsHeight(page) > 0, `"${junk}": the rail must still be laid out`);
      assert.equal(await page.locator("#rail-divider").count(), 1, `"${junk}": the divider must still exist`);
      // POSITIVE control on the reading itself: the same instrument reports "on"
      // for a value that IS valid, so `undefined` above is a real observation.
      await page.locator("#rail-divider").focus();
      await page.keyboard.press("ArrowDown");
      assert.equal(
        await page.evaluate(() => (document.querySelector(".room-rail") as HTMLElement).dataset.split),
        "on",
        `"${junk}": the instrument must report an applied split once one exists`
      );
    } finally {
      await fixture.close();
    }
  }
});

test("the rail does not overflow at 1280 or 390 with a split applied (#275)", async () => {
  const fixture = await startFixture("300");
  try {
    const { page } = fixture;
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction((expected) => window.innerWidth === expected, width);
      // Below 860px a pre-existing breakpoint hides the rail until the Rooms
      // toggle opens it; measuring it while `display: none` would report "no
      // overflow" from an element that is not laid out.
      if (width < 860) {
        await page.click("#rooms-toggle");
        await page.waitForFunction(() => (document.querySelector(".room-rail") as HTMLElement).clientHeight > 0);
      }
      const metrics = await page.evaluate(() => {
        const rail = document.querySelector(".room-rail") as HTMLElement;
        const divider = document.getElementById("rail-divider") as HTMLElement;
        return {
          bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
          railOverflow: rail.scrollWidth - rail.clientWidth,
          dividerVisible: divider.getBoundingClientRect().height > 0,
          lower: Math.round(document.querySelector(".rail-lower")!.getBoundingClientRect().height)
        };
      });
      assert.ok(metrics.bodyOverflow <= 1, `body overflows by ${metrics.bodyOverflow}px at ${width}`);
      assert.ok(metrics.railOverflow <= 1, `rail overflows by ${metrics.railOverflow}px at ${width}`);
      assert.ok(metrics.dividerVisible, `the divider must be visible at ${width}`);
      assert.ok(metrics.lower > 0, `the lower region must remain laid out at ${width}`);
    }
  } finally {
    await fixture.close();
  }
});

test("only a bare number is ever persisted — no room, alias, or token data (#275)", async () => {
  const fixture = await startFixture();
  try {
    const { page } = fixture;
    await page.locator("#rail-divider").focus();
    await page.keyboard.press("ArrowDown");
    const stored = await page.evaluate((key) => window.localStorage.getItem(key as string), SPLIT_KEY);
    // POSITIVE control: something really was written, so the shape check below is
    // not passing on an empty slot.
    assert.ok(stored !== null, "a split must have been persisted");
    assert.match(stored, /^\d+$/, `the persisted split must be a bare integer, got "${stored}"`);
    assert.equal(/rail-fixture-room|owner-1|tgl_|token|alias/i.test(stored), false);
  } finally {
    await fixture.close();
  }
});

test("a stored split still applies when the rail was hidden at load (#275)", async () => {
  // Below 860px the rail is display:none until the Rooms toggle opens it, so at
  // restore time it has no height and the split cannot be clamped yet. The
  // deferred restore has to finish the job when the rail becomes measurable —
  // without it, every narrow-viewport user silently loses their saved split.
  const fixture = await startFixture("300", { width: 390, height: 900 });
  try {
    const { page } = fixture;
    // NEGATIVE control: while the rail is hidden there is genuinely nothing to
    // apply, so the absence below is the expected state rather than a failure.
    assert.equal(
      await page.evaluate(() => (document.querySelector(".room-rail") as HTMLElement).clientHeight),
      0,
      "positive control: the rail really is unlaid-out at this width"
    );

    await page.click("#rooms-toggle");
    await page.waitForFunction(() => (document.querySelector(".room-rail") as HTMLElement).dataset.split === "on");

    // At this width the rail is capped at 40vh by an existing breakpoint, so a
    // stored 300 does not fit and must come back as the clamped maximum — not as
    // 300, and not as nothing. The expected value is derived from the live layout
    // the same way the product derives it, so this stays an exact assertion.
    const expected = Math.min(300, await maxTop(page));
    assert.ok(expected < 300, "positive control: this viewport must actually force a clamp");
    assert.equal(await roomsHeight(page), expected, "the deferred restore must apply the clamped stored split");
  } finally {
    await fixture.close();
  }
});

test("a desktop split re-clamps on 1280 → 390 → open Rooms, keeping the lower minimum (#275)", async () => {
  // The regression @re1 found: the observer used to be installed only when the
  // INITIAL restore failed, so a split that restored fine at 1280 had no observer
  // at all. Moving to 390 left the stale pixel basis against a 40vh rail and the
  // lower region under its floor. Aimed at the MINIMUM, not at overflow — the
  // existing responsive test asserts `lower > 0` and passes straight through this.
  const fixture = await startFixture("300");
  try {
    const { page } = fixture;
    assert.equal(await roomsHeight(page), 300, "positive control: the desktop split really did restore");

    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForFunction(() => window.innerWidth === 390);
    await page.click("#rooms-toggle");
    await page.waitForFunction(() => (document.querySelector(".room-rail") as HTMLElement).clientHeight > 0);

    const expectedMax = await maxTop(page);
    assert.ok(expectedMax < 300, "positive control: this viewport must actually force a clamp");
    // Exact equality, not "<= the maximum": a split pinned to the 120px minimum
    // also satisfies "<=", and that is precisely the wrong-but-passing state an
    // early settle produced.
    await page.waitForFunction(
      (expected) =>
        Math.round(document.querySelector(".rail-rooms")!.getBoundingClientRect().height) === (expected as number),
      expectedMax
    );

    const lower = await page.evaluate(() =>
      Math.round(document.querySelector(".rail-lower")!.getBoundingClientRect().height)
    );
    assert.ok(lower >= MIN_BOTTOM, `the lower region must keep its ${MIN_BOTTOM}px minimum, got ${lower}`);
    assert.equal(await roomsHeight(page), expectedMax, "the split must re-clamp to exactly what now fits");
    // The separator's announced bounds move with the rail, or it would report a
    // maximum this viewport cannot honour.
    assert.equal(await page.locator("#rail-divider").getAttribute("aria-valuemax"), String(expectedMax));
    assert.equal(await page.locator("#rail-divider").getAttribute("aria-valuenow"), String(expectedMax));
  } finally {
    await fixture.close();
  }
});

test("returning to a wide viewport restores the split the user chose, not the clamped one (#275)", async () => {
  // A clamp forced by a small window is not a new preference. If the re-clamp
  // overwrote the desired value, the user would silently lose their split by
  // passing through a narrow viewport.
  const fixture = await startFixture("300");
  try {
    const { page } = fixture;
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForFunction(() => window.innerWidth === 390);
    await page.click("#rooms-toggle");
    await page.waitForFunction(() => (document.querySelector(".room-rail") as HTMLElement).clientHeight > 0);
    const clamped = await roomsHeight(page);
    assert.ok(clamped < 300, "positive control: the narrow viewport must have clamped it");

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(
      () => Math.round(document.querySelector(".rail-rooms")!.getBoundingClientRect().height) === 300
    );
    assert.equal(await roomsHeight(page), 300, "the originally chosen split must come back");
    // And it was never persisted as the clamped value.
    assert.equal(await page.evaluate((key) => window.localStorage.getItem(key as string), SPLIT_KEY), "300");
  } finally {
    await fixture.close();
  }
});

test("a fresh profile with no stored value announces position and bounds (#275)", async () => {
  // The default state every user meets first. A suite that only exercises a
  // stored split keeps passing while this announces nothing at all.
  const fixture = await startFixture();
  try {
    const { page } = fixture;
    assert.equal(
      await page.evaluate((key) => window.localStorage.getItem(key as string), SPLIT_KEY),
      null,
      "positive control: this profile must genuinely have no stored split"
    );
    const divider = page.locator("#rail-divider");
    const measured = await roomsHeight(page);
    assert.equal(await divider.getAttribute("aria-valuenow"), String(measured));
    assert.equal(await divider.getAttribute("aria-valuemin"), String(MIN_TOP));
    assert.equal(await divider.getAttribute("aria-valuemax"), String(await maxTop(page)));
  } finally {
    await fixture.close();
  }
});
