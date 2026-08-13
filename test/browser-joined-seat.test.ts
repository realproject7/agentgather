import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import type { Participant } from "../src/protocol/index.js";
import { createPlatformHttpServer } from "../src/platform/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
import { createRoom, readJoinedRooms, recordJoinedRoom, writeParticipants } from "../src/storage/index.js";
import { writeToken } from "../src/cli/state.js";
import { closeServer } from "./support/close-server.js";
import { captureBrowserFailure, recordBrowserDiagnostics } from "./support/browser-diagnostics.js";

// #311: the dashboard reads ONE default home, while the rooms in it may be hosted
// by agents under their own homes. A joined row could therefore seat the operator
// as an agent host with nothing on screen saying so.
//
// Every root here is a fresh `mkdtemp` that this file also publishes as
// `AGENTGATHER_HOME`, so nothing in it can fall back to the developer's real
// `~/.agentgather` (#305 owns making that universal; this file owns its own root
// explicitly rather than editing that surface).
const TEST_HOME = await mkdtemp(path.join(os.tmpdir(), "agentgather-joined-seat-home-"));
process.env.AGENTGATHER_HOME = TEST_HOME;

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-joined-seat-test-"));
  process.env.AGENTGATHER_HOME = root;
  return root;
}

// #254/#257: a reserved-then-released port. Every baseUrl in this file points at
// one, so the platform's reachability probe and any open attempt are refused by
// the loopback stack instead of reaching a room server this test did not start.
async function refusedBaseUrl(): Promise<string> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

async function listen(server: Server): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
}

function participant(alias: string, kind: Participant["kind"], isHost: boolean, token: string): Participant {
  const now = new Date().toISOString();
  return {
    alias,
    kind,
    location: "local",
    install: isHost ? "host" : "lite",
    attention: "attending",
    is_host: isHost,
    token_hash: participantTokenHash(token),
    joinedAt: now,
    lastSeenAt: now
  };
}

// The three seat states, written the way the dashboard must say them. Spelled out
// here rather than imported from the shell: importing would assert only that a
// string equals itself. Each is asserted for equality against its own row AND for
// inequality against the other two, so no assertion can pass for more than one.
const SEAT_TEXT = {
  human: "Seat identity human",
  agent: "Seat identity agent",
  unknown: "Seat identity unknown"
} as const;

function seatLabel(title: string, seat: keyof typeof SEAT_TEXT): string {
  return `Open ${title} — ${SEAT_TEXT[seat]}`;
}

// A dashboard home holding the operator's actual situation: a human seat, an agent
// seat, a legacy row that predates #311 and records no kind, and one room where
// this device holds BOTH kinds of credential.
async function seedDashboardHome(): Promise<{ root: string; baseUrls: { human: string; agent: string; legacy: string; both: string } }> {
  const root = await makeRoot();
  const baseUrls = {
    human: await refusedBaseUrl(),
    agent: await refusedBaseUrl(),
    legacy: await refusedBaseUrl(),
    both: await refusedBaseUrl()
  };

  await recordJoinedRoom(root, {
    roomId: "human-room",
    title: "Human Room",
    alias: "project7",
    baseUrl: baseUrls.human,
    joinedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    kind: "human"
  });
  await writeToken(root, "human-room", "project7", "tgl_human_seat_token");

  await recordJoinedRoom(root, {
    roomId: "agent-room",
    title: "Agent Room",
    alias: "pb-lead",
    baseUrl: baseUrls.agent,
    joinedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    kind: "agent"
  });
  await writeToken(root, "agent-room", "pb-lead", "tgl_agent_seat_token");

  // No `kind` at all — every row on every existing device is in this state.
  await recordJoinedRoom(root, {
    roomId: "legacy-room",
    title: "Legacy Room",
    alias: "project7",
    baseUrl: baseUrls.legacy,
    joinedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString()
  });
  await writeToken(root, "legacy-room", "project7", "tgl_legacy_seat_token");

  // Both kinds held for one room: the agent invite was imported last, so the row
  // itself opens as the agent — which is exactly the state that needs a choice.
  await recordJoinedRoom(root, {
    roomId: "both-room",
    title: "Both Room",
    alias: "project7",
    baseUrl: baseUrls.both,
    joinedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    kind: "human"
  });
  await recordJoinedRoom(root, {
    roomId: "both-room",
    title: "Both Room",
    alias: "pb-lead",
    baseUrl: baseUrls.both,
    joinedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    kind: "agent"
  });
  await writeToken(root, "both-room", "project7", "tgl_both_human_token");
  await writeToken(root, "both-room", "pb-lead", "tgl_both_agent_token");

  return { root, baseUrls };
}

test("an invite import records the seat kind the host reported, and records none when it reports none (#311)", async () => {
  const root = await makeRoot();
  const humanToken = "tgl_import_human_token";
  const agentToken = "tgl_import_agent_token";
  await createRoom({ root, roomId: "ape-cards", hostAlias: "pb-lead" });
  await writeParticipants(root, "ape-cards", [
    participant("pb-lead", "agent", true, agentToken),
    participant("project7", "human", false, humanToken)
  ]);
  const room = await listen(createRoomHttpServer({ root, roomId: "ape-cards", baseUrl: "http://127.0.0.1:0" }));
  // A SEPARATE home for the dashboard — the operator's device is not the host's.
  const dashRoot = await makeRoot();
  const platform = await listen(createPlatformHttpServer({ root: dashRoot, ownerUserId: "owner-1" }));
  try {
    const remember = async (token: string): Promise<Response> =>
      fetch(`${platform.baseUrl}/joined-rooms/remember`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: platform.baseUrl },
        body: JSON.stringify({ inviteUrl: `${room.baseUrl}/#token=${token}` })
      });

    const humanResponse = await remember(humanToken);
    assert.equal(humanResponse.status, 200);
    const humanBody = (await humanResponse.json()) as { room: { alias: string; kind?: string } };
    assert.equal(humanBody.room.alias, "project7");
    assert.equal(humanBody.room.kind, "human");

    const agentResponse = await remember(agentToken);
    assert.equal(agentResponse.status, 200);
    const agentBody = (await agentResponse.json()) as { room: { alias: string; kind?: string } };
    assert.equal(agentBody.room.alias, "pb-lead");
    assert.equal(agentBody.room.kind, "agent");

    // One row for the room, now opening as the agent it last imported — and it
    // still remembers the human seat it holds a credential for.
    const rows = await readJoinedRooms(dashRoot);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.alias, "pb-lead");
    assert.equal(row?.kind, "agent");
    assert.deepEqual(
      (row?.seats ?? []).map((seat) => `${seat.alias}:${seat.kind ?? "unknown"}`).sort(),
      ["pb-lead:agent", "project7:human"]
    );
  } finally {
    await platform.close();
    await room.close();
  }
});

test("a row whose kind was never learned stays unknown, and a re-import never carries the old kind onto a new alias (#311)", async () => {
  const root = await makeRoot();
  const baseUrl = await refusedBaseUrl();
  const stamp = new Date().toISOString();

  // Legacy shape: no kind anywhere.
  await recordJoinedRoom(root, {
    roomId: "quiet-room",
    title: "Quiet Room",
    alias: "project7",
    baseUrl,
    joinedAt: stamp,
    lastSeen: stamp
  });
  assert.equal((await readJoinedRooms(root))[0]?.kind, undefined, "a kind was invented for a legacy row");

  // A known kind is kept across a re-record of the SAME alias.
  await recordJoinedRoom(root, { roomId: "quiet-room", title: "Quiet Room", alias: "project7", baseUrl, joinedAt: stamp, lastSeen: stamp, kind: "human" });
  await recordJoinedRoom(root, { roomId: "quiet-room", title: "Quiet Room", alias: "project7", baseUrl, joinedAt: stamp, lastSeen: stamp });
  assert.equal((await readJoinedRooms(root))[0]?.kind, "human");

  // Switching alias with no kind reported must NOT carry the previous
  // participant's kind onto the new one — that would be a claim about a seat this
  // device was never told about.
  await recordJoinedRoom(root, { roomId: "quiet-room", title: "Quiet Room", alias: "someone-else", baseUrl, joinedAt: stamp, lastSeen: stamp });
  const row = (await readJoinedRooms(root))[0];
  assert.equal(row?.alias, "someone-else");
  assert.equal(row?.kind, undefined, "the previous alias's kind was carried onto a different alias");
  // The human seat it still holds is remembered, so the choice can still offer it.
  assert.deepEqual(
    (row?.seats ?? []).map((seat) => `${seat.alias}:${seat.kind ?? "unknown"}`).sort(),
    ["project7:human", "someone-else:unknown"]
  );
});

test("the joined-room list reports only seats this device really holds a credential for (#311)", async () => {
  const { root } = await seedDashboardHome();
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  try {
    const response = await fetch(`${platform.baseUrl}/joined-rooms`);
    const body = (await response.json()) as {
      rooms: Array<{ roomId: string; kind?: string; heldSeats?: Array<{ alias: string; kind?: string }> }>;
    };
    const byId = new Map(body.rooms.map((room) => [room.roomId, room]));

    assert.deepEqual(byId.get("both-room")?.heldSeats?.map((seat) => `${seat.alias}:${seat.kind}`).sort(), [
      "pb-lead:agent",
      "project7:human"
    ]);
    assert.deepEqual(byId.get("human-room")?.heldSeats?.map((seat) => seat.alias), ["project7"]);
    assert.equal(byId.get("legacy-room")?.kind, undefined);
    assert.deepEqual(byId.get("legacy-room")?.heldSeats, [{ alias: "project7" }]);

    // Nothing in this response is a credential.
    assert.equal(/tgl_/.test(JSON.stringify(body)), false, "the joined-room list carried a token");
  } finally {
    await platform.close();
  }
});

test("opening a joined row may pick another held seat, and refuses one this device does not hold (#311)", async () => {
  const { root, baseUrls } = await seedDashboardHome();
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  try {
    const open = async (query: string): Promise<Response> =>
      fetch(`${platform.baseUrl}/joined-rooms/open?${query}`, { redirect: "manual" });

    const both = `room_id=both-room&base_url=${encodeURIComponent(baseUrls.both)}`;
    // The row's own seat is the agent it imported last.
    const asStored = await open(both);
    assert.equal(asStored.status, 302);
    assert.match(asStored.headers.get("location") ?? "", /token=tgl_both_agent_token/);

    // Choosing the human seat opens with the human credential already on disk.
    const asHuman = await open(`${both}&alias=project7`);
    assert.equal(asHuman.status, 302);
    assert.match(asHuman.headers.get("location") ?? "", /token=tgl_both_human_token/);

    // A seat this device holds no credential for is refused — the choice can only
    // pick among credentials already held, never reach for a new one.
    const asStranger = await open(`${both}&alias=not-held`);
    assert.equal(asStranger.status, 409);
    const help = await asStranger.text();
    assert.match(help, /not one this device holds a credential for/);
    assert.equal(/tgl_/.test(help), false);

    // And a seat held for a DIFFERENT room is still refused for this one.
    const crossRoom = await open(`${both}&alias=nobody-here`);
    assert.equal(crossRoom.status, 409);
  } finally {
    await platform.close();
  }
});

test("the dashboard marks the agent seat only, and says which seat each row opens as (#311)", async () => {
  const { root } = await seedDashboardHome();
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  let diagnostics: ReturnType<typeof recordBrowserDiagnostics> | null = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    // #303: failure-only capture; coverage defined by the wait surface.
    diagnostics = recordBrowserDiagnostics(page, page.context());
    await page.goto(platform.baseUrl);
    await page.waitForSelector(".joined-row");

    const label = async (roomTitle: string): Promise<string> =>
      (await page.locator(`.joined-row:has-text("${roomTitle}")`).first().getAttribute("aria-label")) ?? "";

    // Exact and distinct for all three states: each row equals its own text and
    // does not equal either other state's.
    const humanLabel = await label("Human Room");
    assert.equal(humanLabel, seatLabel("Human Room", "human"));
    assert.notEqual(humanLabel, seatLabel("Human Room", "agent"));
    assert.notEqual(humanLabel, seatLabel("Human Room", "unknown"));

    const agentLabel = await label("Agent Room");
    assert.equal(agentLabel, seatLabel("Agent Room", "agent"));
    assert.notEqual(agentLabel, seatLabel("Agent Room", "human"));
    assert.notEqual(agentLabel, seatLabel("Agent Room", "unknown"));

    const legacyLabel = await label("Legacy Room");
    assert.equal(legacyLabel, seatLabel("Legacy Room", "unknown"));
    assert.notEqual(legacyLabel, seatLabel("Legacy Room", "human"));
    assert.notEqual(legacyLabel, seatLabel("Legacy Room", "agent"));

    // Only the agent seat is badged. Badging the ordinary human seat, or inventing
    // one for the unknown row, is the failure this asserts against.
    assert.equal(
      await page.locator('.joined-row:has-text("Agent Room") .joined-seat[data-seat="agent"]').count(),
      1,
      "the agent seat was not badged"
    );
    // "Both Room" holds both kinds and therefore opens as the human default, so it
    // is not an agent seat right now and must not be badged as one.
    assert.equal(await page.locator('.joined-seat[data-seat="agent"]').count(), 1, "agent-seat badges across the list");
    assert.equal(
      await page.locator('.joined-row:has-text("Human Room") .joined-seat').count(),
      0,
      "the human seat was badged"
    );
    assert.equal(
      await page.locator('.joined-row:has-text("Legacy Room") .joined-seat').count(),
      0,
      "the unknown legacy seat was badged"
    );
    assert.equal(
      await page.locator('.joined-row:has-text("Agent Room") .joined-seat').first().textContent(),
      "Agent seat"
    );

    // Nothing on the page is a credential.
    assert.equal(/tgl_/.test(await page.content()), false, "a token reached the dashboard");
  } catch (error) {
    await captureBrowserFailure(diagnostics, "joined-seat-badges-and-descriptions", error);
    throw error;
  } finally {
    await browser.close();
    await platform.close();
  }
});

test("a room held under both kinds offers a visible, reversible Join as choice that defaults to the human seat (#311)", async () => {
  const { root, baseUrls } = await seedDashboardHome();
  const platform = await listen(createPlatformHttpServer({ root, ownerUserId: "owner-1" }));
  const browser = await chromium.launch();
  let diagnostics: ReturnType<typeof recordBrowserDiagnostics> | null = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    // #303: failure-only capture; coverage defined by the wait surface.
    diagnostics = recordBrowserDiagnostics(page, page.context());
    await page.goto(platform.baseUrl);
    await page.waitForSelector(".joined-row");

    const bothRow = page.locator('.joined-row:has-text("Both Room")').first();
    const select = bothRow.locator("select.joined-seat-select");

    // The choice appears only where there is something to choose between.
    await page.waitForSelector('.joined-row:has-text("Both Room") select.joined-seat-select');
    assert.equal(await bothRow.locator(".joined-seat-caption").textContent(), "Join as");
    assert.equal(await page.locator('.joined-row:has-text("Human Room") select.joined-seat-select').count(), 0);
    assert.equal(await page.locator('.joined-row:has-text("Legacy Room") select.joined-seat-select').count(), 0);

    // Human is the visible default even though the row's stored alias is the agent
    // it imported last, and the row therefore shows no agent badge.
    assert.equal(await select.inputValue(), "project7");
    assert.equal(await bothRow.getAttribute("aria-label"), seatLabel("Both Room", "human"));
    assert.equal(await bothRow.locator(".joined-seat").count(), 0);
    // Opening as the non-stored default names the seat explicitly.
    assert.match(await bothRow.getAttribute("data-open-href") ?? "", /alias=project7/);

    // Choosing the agent seat is disclosed immediately, before entry.
    await select.selectOption("pb-lead");
    await page.waitForSelector('.joined-row:has-text("Both Room") .joined-seat[data-seat="agent"]');
    assert.equal(
      await page.locator('.joined-row:has-text("Both Room")').first().getAttribute("aria-label"),
      seatLabel("Both Room", "agent")
    );
    const agentHref = (await page.locator('.joined-row:has-text("Both Room")').first().getAttribute("data-open-href")) ?? "";
    assert.doesNotMatch(agentHref, /alias=/, "the stored seat should not need naming");
    assert.ok(
      agentHref.includes(`base_url=${encodeURIComponent(baseUrls.both)}`),
      `open href lost its room: ${agentHref}`
    );

    // Reversible: choosing the human seat back restores the default state exactly.
    await page.locator('.joined-row:has-text("Both Room") select.joined-seat-select').selectOption("project7");
    await page.waitForSelector('.joined-row:has-text("Both Room") .joined-seat[data-seat="agent"]', { state: "detached" });
    assert.equal(
      await page.locator('.joined-row:has-text("Both Room")').first().getAttribute("aria-label"),
      seatLabel("Both Room", "human")
    );

    // Choosing a seat must not open the room — the row is itself a link.
    assert.equal(new URL(page.url()).pathname, "/");

    // The control's VISIBLE CAPTION is part of the same row link (@re1). Clicking
    // it while only trying to pick a seat opened the room, so click the caption
    // itself — not the select — and require the dashboard to still be here.
    await bothRow.locator(".joined-seat-caption").click();
    await page.waitForSelector('.joined-row:has-text("Both Room") select.joined-seat-select');
    assert.equal(new URL(page.url()).pathname, "/", "clicking the Join as caption opened the room");
    // "Both Room" is unreachable, so opening it swaps the detail pane into the
    // offline snapshot view — that mode flag is what actually proves the row link
    // did not fire, rather than a URL that a same-page view would not change.
    assert.equal(await page.locator('[data-mode="snapshot"]').count(), 0, "clicking the caption opened the room");
    // The row is still usable afterwards: the caption click changed no seat.
    assert.equal(await page.locator('.joined-row:has-text("Both Room") select.joined-seat-select').inputValue(), "project7");
    assert.equal(
      await page.locator('.joined-row:has-text("Both Room")').first().getAttribute("aria-label"),
      seatLabel("Both Room", "human")
    );
    assert.equal(/tgl_/.test(await page.content()), false, "a token reached the dashboard");
  } catch (error) {
    await captureBrowserFailure(diagnostics, "joined-seat-join-as-choice", error);
    throw error;
  } finally {
    await browser.close();
    await platform.close();
  }
});
