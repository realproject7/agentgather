// #293 — a damaged offline snapshot must be distinguishable from having none,
// from the store, through the loopback API, to what the user is shown.
//
// All three states are asserted with exact expected values — "does not crash" is
// not an assertion. Every fixture is written by this test into a throwaway home;
// nothing reads a real snapshot, and no request leaves the fixture it started.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlatformHttpServer } from "../src/platform/index.js";
import {
  joinedHistoryPath,
  readJoinedHistory,
  recordJoinedHistory,
  recordJoinedRoom,
  writeSecureFile
} from "../src/storage/index.js";
import { closeServer } from "./support/close-server.js";

const HOST = "http://127.0.0.1:9310";
const KEY = { roomId: "damaged-room", baseUrl: HOST };
const OTHER = { roomId: "healthy-room", baseUrl: HOST };

async function makeHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-snapshot-state-test-"));
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function track(home: string, key: { roomId: string; baseUrl: string }): Promise<void> {
  const now = new Date(0).toISOString();
  await recordJoinedRoom(home, {
    roomId: key.roomId,
    title: key.roomId,
    alias: "operator",
    baseUrl: key.baseUrl,
    joinedAt: now,
    lastSeen: now
  });
}

async function seedSnapshot(home: string, key: { roomId: string; baseUrl: string }, text: string): Promise<void> {
  await recordJoinedHistory(home, {
    roomId: key.roomId,
    baseUrl: key.baseUrl,
    savedAt: new Date(0).toISOString(),
    messages: [{ id: 1, from: "someone", ts: new Date(0).toISOString(), type: "chat", text }]
  });
}

// The damaged file carries a distinctive marker so the tests can prove no byte of
// it reaches the response — a bare "{ not json" would be indistinguishable from
// any other parse failure in the output.
const DAMAGED_MARKER = "TRIPWIRE-SNAPSHOT-CONTENT-9f3a";

// Corruption shape matters for this invariant (@re2, msg 1307). `JSON.parse`
// only quotes the file's own bytes for SOME shapes:
//
//   leading non-JSON  -> Unexpected token 'T', "TRIPWIRE-S"... is not valid JSON  <- ECHOES
//   truncated object  -> Expected ',' or '}' after property value ... position 77 <- positional
//   trailing garbage  -> Unexpected non-whitespace character ... position 8        <- positional
//
// A non-echo assertion driven only by a positional shape cannot fail even against
// code that surfaces `error.message` — it would be a test that guards nothing. So
// the echoing shape is the primary fixture, and `parseMessageEchoes` below proves
// on the spot that this Node really does echo for it.
const DAMAGED_SHAPES = {
  // Marker FIRST, so the parse error quotes it. This is also the realistic case:
  // a partially-overwritten file or a stray log line prepended to the snapshot.
  echoing: `${DAMAGED_MARKER} not json`,
  truncated: `{"roomId":"damaged-room","messages":[{"text":"${DAMAGED_MARKER}"`
} as const;

// V8 quotes only the first ~10 bytes of the offending input, so the leaked
// fragment is a PREFIX of the file, not the whole marker. Checking for the full
// marker would report "no echo" for a message that is visibly echoing — the
// instrument would be wrong in the reassuring direction.
const ECHOED_PREFIX = DAMAGED_MARKER.slice(0, 10);

function parseMessageEchoes(raw: string): boolean {
  try {
    JSON.parse(raw);
    return false;
  } catch (error) {
    return (error as Error).message.includes(ECHOED_PREFIX);
  }
}

async function damage(
  home: string,
  key: { roomId: string; baseUrl: string },
  shape: keyof typeof DAMAGED_SHAPES = "echoing"
): Promise<void> {
  await writeSecureFile(joinedHistoryPath(home, key), DAMAGED_SHAPES[shape]);
}

async function startServer(root: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createPlatformHttpServer({ root, ownerUserId: "owner-1" });
  const port = await getFreePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
}

function historyUrl(base: string, key: { roomId: string; baseUrl: string }): string {
  return `${base}/joined-rooms/history?room_id=${encodeURIComponent(key.roomId)}&base_url=${encodeURIComponent(key.baseUrl)}`;
}

test("the API reports absent, ok and unreadable as three distinct states (#293)", async () => {
  const root = await makeHome();
  await track(root, KEY);
  const fixture = await startServer(root);
  try {
    // 1. Absent — the ordinary case for a room never opened offline. Unchanged
    //    from today, and carries no warning.
    const absent = await (await fetch(historyUrl(fixture.baseUrl, KEY))).json();
    assert.deepEqual(absent, { ok: true, snapshot: null, state: "absent" });

    // 2. Valid — the snapshot is served, with the state saying so.
    await seedSnapshot(root, KEY, "saved line");
    const valid = (await (await fetch(historyUrl(fixture.baseUrl, KEY))).json()) as {
      ok: boolean;
      state: string;
      snapshot: { messages: { text: string }[] } | null;
    };
    assert.equal(valid.ok, true);
    assert.equal(valid.state, "ok");
    assert.equal(valid.snapshot?.messages[0]?.text, "saved line");

    // 3. Damaged — reported as unreadable, NOT flattened into absence.
    await damage(root, KEY);
    const damaged = await (await fetch(historyUrl(fixture.baseUrl, KEY))).json();
    assert.deepEqual(damaged, { ok: true, snapshot: null, state: "unreadable" });
  } finally {
    await fixture.close();
  }
});

test("an unreadable snapshot is a 200 with a reported condition, never a 500 (#293)", async () => {
  const root = await makeHome();
  await track(root, KEY);
  await damage(root, KEY);
  const fixture = await startServer(root);
  try {
    const res = await fetch(historyUrl(fixture.baseUrl, KEY));
    assert.equal(res.status, 200, "a damaged local file is a reported state, not a server error");
    assert.equal((await res.json() as { state: string }).state, "unreadable");
  } finally {
    await fixture.close();
  }
});

test("nothing from the damaged file's contents reaches the response (#293)", async () => {
  // Instrument check FIRST: prove this runtime's parse error really does quote the
  // file for the echoing shape, and really does not for the truncated one. Without
  // this, "the marker is absent from the response" could simply mean the error
  // never contained it — a passing assertion about nothing.
  assert.equal(parseMessageEchoes(DAMAGED_SHAPES.echoing), true, "the echoing shape must genuinely echo here");
  assert.equal(parseMessageEchoes(DAMAGED_SHAPES.truncated), false, "the truncated shape is positional");

  for (const shape of ["echoing", "truncated"] as const) {
    const root = await makeHome();
    await track(root, KEY);
    await damage(root, KEY, shape);
    const fixture = await startServer(root);
    try {
      await assertNoLeak(fixture.baseUrl, root, shape);
    } finally {
      await fixture.close();
    }
  }
});

async function assertNoLeak(baseUrl: string, root: string, shape: string): Promise<void> {
  {
    const body = await (await fetch(historyUrl(baseUrl, KEY))).text();
    // Positive control: the marker really is in the file on disk, so its absence
    // from the response is a fact about the response and not about the fixture.
    const onDisk = await readFile(joinedHistoryPath(root, KEY), "utf8");
    assert.ok(onDisk.includes(DAMAGED_MARKER), `${shape}: the fixture must actually contain the tripwire`);

    assert.equal(body.includes(DAMAGED_MARKER), false, `${shape}: no byte of the damaged file may be echoed`);
    // The leaked form is a prefix, so guard the prefix too — checking only the
    // full marker would miss exactly what this shape actually leaks.
    assert.equal(body.includes(ECHOED_PREFIX), false, `${shape}: not even the quoted prefix may appear`);
    // Nor a parse fragment, an error message, or the path it was read from. A
    // JSON parse error message routinely quotes the offending token.
    assert.equal(/Unexpected|JSON|SyntaxError|position \d+/i.test(body), false, `parse detail leaked: ${body}`);
    assert.equal(body.includes(root), false, `${shape}: the filesystem path must not appear`);
    assert.equal(/joined-history|\.json/i.test(body), false, "no internal file naming may appear");
    // The whole response is still just the three known keys.
    assert.deepEqual(Object.keys(JSON.parse(body) as Record<string, unknown>).sort(), ["ok", "snapshot", "state"]);
  }
}

test("one damaged snapshot does not affect any other room's snapshot or the room list (#293)", async () => {
  const root = await makeHome();
  await track(root, KEY);
  await track(root, OTHER);
  await seedSnapshot(root, OTHER, "healthy line");
  await damage(root, KEY);
  const fixture = await startServer(root);
  try {
    // The damaged room reports unreadable...
    assert.equal(
      ((await (await fetch(historyUrl(fixture.baseUrl, KEY))).json()) as { state: string }).state,
      "unreadable"
    );
    // ...while the healthy room is entirely unaffected, in the same server, in
    // the same home directory.
    const healthy = (await (await fetch(historyUrl(fixture.baseUrl, OTHER))).json()) as {
      state: string;
      snapshot: { messages: { text: string }[] } | null;
    };
    assert.equal(healthy.state, "ok");
    assert.equal(healthy.snapshot?.messages[0]?.text, "healthy line");

    // And the dashboard's other surfaces still answer normally.
    const rooms = await fetch(`${fixture.baseUrl}/joined-rooms`);
    assert.equal(rooms.status, 200);
    const listed = (await rooms.json()) as { ok: boolean; rooms: { roomId: string }[] };
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.rooms.map((room) => room.roomId).sort(), ["damaged-room", "healthy-room"]);
  } finally {
    await fixture.close();
  }
});

test("a snapshot that cannot be opened at all reads as unreadable, not absent (#293)", async () => {
  // Not every failure is a parse failure. A directory where the file should be
  // reproduces EISDIR — the class the host-log path (#242) rethrows rather than
  // presenting as an authoritative empty history.
  const root = await makeHome();
  const { mkdir } = await import("node:fs/promises");
  const target = joinedHistoryPath(root, KEY);
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(target, { recursive: true });
  assert.deepEqual(await readJoinedHistory(root, KEY), { state: "unreadable", snapshot: null });
});

test("a snapshot whose stored key names another room is unreadable, not absent (#293)", async () => {
  const root = await makeHome();
  const target = joinedHistoryPath(root, KEY);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(target), { recursive: true });
  // Well-formed JSON, wrong room: the file exists and is not what it claims.
  await writeFile(
    target,
    JSON.stringify({ roomId: "someone-elses-room", baseUrl: HOST, cursor: 0, savedAt: "", messages: [], forumPosts: [] })
  );
  assert.deepEqual(await readJoinedHistory(root, KEY), { state: "unreadable", snapshot: null });
});
