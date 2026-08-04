// #277 — bulk archive/delete over a selection of device-local joined rooms.
//
// Every test here builds its OWN synthetic joined-rooms list (60+ entries, all on
// unroutable 127.0.0.1 ports that nothing is listening on). No test reads, writes,
// or infers anything from a real joined-rooms list: a bug in a bulk delete would
// destroy rooms someone cares about, so the fixture is always fabricated here.
//
// The central invariant is EXACTNESS: a bulk action changes precisely the rows it
// was given and leaves every other row byte-identical. Asserting only that the
// selected rows changed would pass just as happily if the call had emptied the
// whole store, so every test also pins the bystanders.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deleteJoinedRooms,
  joinedRoomsPath,
  readJoinedHistory,
  readJoinedRooms,
  recordJoinedHistory,
  recordJoinedRoom,
  setJoinedRoomsArchived,
  type JoinedRoom
} from "../src/storage/index.js";

async function makeHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-joined-bulk-test-"));
}

const FIXTURE_SIZE = 63;

// A synthetic joined room. Ports 1..N on loopback are never contacted by these
// tests — the store is pure metadata and no code under test dials a host.
function syntheticRoom(index: number): JoinedRoom {
  const stamp = new Date(Date.UTC(2026, 0, 1, 0, index % 60)).toISOString();
  return {
    roomId: `synthetic-room-${String(index).padStart(3, "0")}`,
    title: `Synthetic Room ${index}`,
    alias: index % 2 === 0 ? "operator" : "agent",
    baseUrl: `http://127.0.0.1:${9000 + index}`,
    joinedAt: stamp,
    lastSeen: stamp
  };
}

// Seed a home with FIXTURE_SIZE synthetic rooms, sequentially so the writer lock
// is never contended during setup.
async function seedFixture(home: string, size = FIXTURE_SIZE): Promise<JoinedRoom[]> {
  const rooms: JoinedRoom[] = [];
  for (let index = 0; index < size; index += 1) {
    const room = syntheticRoom(index);
    rooms.push(room);
    await recordJoinedRoom(home, room);
  }
  const stored = await readJoinedRooms(home);
  assert.equal(stored.length, size, "fixture must seed the full synthetic list");
  return rooms;
}

function keyOf(room: { roomId: string; baseUrl: string }): string {
  return `${room.roomId}|${room.baseUrl}`;
}

function targetsOf(rooms: JoinedRoom[]): { roomId: string; baseUrl: string }[] {
  return rooms.map((room) => ({ roomId: room.roomId, baseUrl: room.baseUrl }));
}

test("bulk archive changes exactly the selection and leaves every other row untouched", async () => {
  const home = await makeHome();
  const seeded = await seedFixture(home);
  const before = await readJoinedRooms(home);
  // A deliberately scattered subset — not a prefix, not a suffix — so an
  // off-by-one slice or a sort-order assumption shows up as a wrong row.
  const selected = seeded.filter((_room, index) => index % 7 === 3);
  assert.ok(selected.length >= 5 && selected.length < seeded.length, "subset must be strict and non-trivial");
  const selectedKeys = new Set(selected.map(keyOf));

  const result = await setJoinedRoomsArchived(home, targetsOf(selected), true);
  assert.deepEqual(result, {
    requested: selected.length,
    matched: selected.length,
    changed: selected.length,
    missing: 0
  });

  const after = await readJoinedRooms(home);
  assert.equal(after.length, before.length, "archiving must not add or remove rows");
  for (const room of after) {
    const original = before.find((entry) => keyOf(entry) === keyOf(room));
    assert.ok(original !== undefined, `row ${room.roomId} must have existed before the call`);
    if (selectedKeys.has(keyOf(room))) {
      assert.equal(room.archived, true, `${room.roomId} was selected and must be archived`);
      // Nothing but the flag may move on a selected row either.
      assert.deepEqual({ ...room, archived: undefined }, { ...original, archived: undefined });
      continue;
    }
    // The load-bearing assertion: an unselected row is still present AND is
    // byte-for-byte what it was, including the absence of `archived`.
    assert.deepEqual(room, original, `${room.roomId} was NOT selected and must be unchanged`);
    assert.equal("archived" in room, false, `${room.roomId} must not have gained an archived flag`);
  }
  // Every unselected row is still present, by key.
  for (const original of before) {
    if (selectedKeys.has(keyOf(original))) continue;
    assert.ok(
      after.some((room) => keyOf(room) === keyOf(original)),
      `unselected row ${original.roomId} must still be present`
    );
  }
});

test("bulk delete removes exactly the selection and leaves every other row present and unchanged", async () => {
  const home = await makeHome();
  const seeded = await seedFixture(home);
  const before = await readJoinedRooms(home);
  const selected = seeded.filter((_room, index) => index % 5 === 2);
  assert.ok(selected.length >= 5 && selected.length < seeded.length, "subset must be strict and non-trivial");
  const selectedKeys = new Set(selected.map(keyOf));

  const result = await deleteJoinedRooms(home, targetsOf(selected));
  assert.deepEqual(result, {
    requested: selected.length,
    matched: selected.length,
    changed: selected.length,
    missing: 0
  });

  const after = await readJoinedRooms(home);
  assert.equal(after.length, before.length - selected.length);
  for (const room of after) {
    assert.equal(selectedKeys.has(keyOf(room)), false, `${room.roomId} was selected and must be gone`);
  }
  const survivors = before.filter((room) => !selectedKeys.has(keyOf(room)));
  // Same rows, same order, same contents — a bulk delete must not silently
  // rewrite, reorder, or normalise the rows it did not target.
  assert.deepEqual(after, survivors);
});

test("bulk archive is keyed on roomId AND baseUrl, so a sibling room on the same host is never swept in", async () => {
  const home = await makeHome();
  const host = "http://127.0.0.1:9500";
  const target: JoinedRoom = {
    roomId: "shared-host-a",
    title: "A",
    alias: "operator",
    baseUrl: host,
    joinedAt: new Date(0).toISOString(),
    lastSeen: new Date(0).toISOString()
  };
  const sibling: JoinedRoom = { ...target, roomId: "shared-host-b", title: "B" };
  // Same room id on a different host — the other half of the compound key.
  const namesake: JoinedRoom = { ...target, baseUrl: "http://127.0.0.1:9501", title: "C" };
  await recordJoinedRoom(home, target);
  await recordJoinedRoom(home, sibling);
  await recordJoinedRoom(home, namesake);

  const result = await setJoinedRoomsArchived(home, [{ roomId: target.roomId, baseUrl: target.baseUrl }], true);
  assert.equal(result.changed, 1);
  const after = await readJoinedRooms(home);
  assert.equal(after.length, 3);
  // Resolve each bystander explicitly and assert it EXISTS before asserting what
  // it lacks: `"archived" in undefined ?? {}` would report false for a row that
  // had been deleted outright, turning this into a test that cannot fail.
  const find = (roomId: string, baseUrl: string): JoinedRoom => {
    const row = after.find((room) => room.roomId === roomId && room.baseUrl === baseUrl);
    assert.ok(row !== undefined, `${roomId} @ ${baseUrl} must still be present`);
    return row;
  };
  assert.equal(find(target.roomId, target.baseUrl).archived, true);
  assert.equal("archived" in find(sibling.roomId, sibling.baseUrl), false, "same host, different room: untouched");
  assert.equal("archived" in find(namesake.roomId, namesake.baseUrl), false, "same room id, different host: untouched");
});

test("bulk delete clears each deleted room's offline snapshot and keeps every other snapshot", async () => {
  const home = await makeHome();
  const seeded = await seedFixture(home, 8);
  for (const room of seeded) {
    await recordJoinedHistory(home, {
      roomId: room.roomId,
      baseUrl: room.baseUrl,
      savedAt: new Date(0).toISOString(),
      messages: [{ id: 1, from: "someone", ts: new Date(0).toISOString(), type: "chat", text: "hello" }]
    });
  }
  const deleted = [seeded[1], seeded[4]].filter((room): room is JoinedRoom => room !== undefined);
  await deleteJoinedRooms(home, targetsOf(deleted));

  for (const room of deleted) {
    const snapshot = await readJoinedHistory(home, { roomId: room.roomId, baseUrl: room.baseUrl });
    assert.equal(snapshot, null, `${room.roomId} was deleted so its snapshot must be gone`);
  }
  for (const room of seeded) {
    if (deleted.some((entry) => keyOf(entry) === keyOf(room))) continue;
    const snapshot = await readJoinedHistory(home, { roomId: room.roomId, baseUrl: room.baseUrl });
    assert.notEqual(snapshot, null, `${room.roomId} was not deleted so its snapshot must survive`);
  }
});

test("bulk archive RETAINS the offline snapshot (#247), unlike delete", async () => {
  const home = await makeHome();
  const seeded = await seedFixture(home, 6);
  for (const room of seeded) {
    await recordJoinedHistory(home, {
      roomId: room.roomId,
      baseUrl: room.baseUrl,
      savedAt: new Date(0).toISOString(),
      messages: [{ id: 1, from: "someone", ts: new Date(0).toISOString(), type: "chat", text: "keep me" }]
    });
  }
  await setJoinedRoomsArchived(home, targetsOf(seeded), true);
  for (const room of seeded) {
    const snapshot = await readJoinedHistory(home, { roomId: room.roomId, baseUrl: room.baseUrl });
    assert.notEqual(snapshot, null, `${room.roomId} was archived, not deleted — its transcript must remain`);
  }
});

test("targets with no stored row are reported as missing instead of failing the batch", async () => {
  const home = await makeHome();
  const seeded = await seedFixture(home, 10);
  const present = seeded.slice(0, 3);
  const absent = [
    { roomId: "never-joined", baseUrl: "http://127.0.0.1:9999" },
    { roomId: "also-never-joined", baseUrl: "http://127.0.0.1:9998" }
  ];
  const result = await setJoinedRoomsArchived(home, [...targetsOf(present), ...absent], true);
  assert.deepEqual(result, { requested: 5, matched: 3, changed: 3, missing: 2 });
  const after = await readJoinedRooms(home);
  assert.equal(after.length, 10, "a missing target must not remove or add rows");
  assert.equal(after.filter((room) => room.archived === true).length, 3);
});

test("a repeated target counts once and is applied once", async () => {
  const home = await makeHome();
  const seeded = await seedFixture(home, 5);
  const one = seeded[0];
  assert.ok(one !== undefined);
  const result = await setJoinedRoomsArchived(
    home,
    [
      { roomId: one.roomId, baseUrl: one.baseUrl },
      { roomId: one.roomId, baseUrl: one.baseUrl },
      { roomId: one.roomId, baseUrl: one.baseUrl }
    ],
    true
  );
  assert.deepEqual(result, { requested: 1, matched: 1, changed: 1, missing: 0 });
});

test("re-archiving an already-archived row matches but reports no change and does not rewrite the file", async () => {
  const home = await makeHome();
  const seeded = await seedFixture(home, 6);
  await setJoinedRoomsArchived(home, targetsOf(seeded), true);
  const contentsAfterFirst = await readFile(joinedRoomsPath(home), "utf8");

  const second = await setJoinedRoomsArchived(home, targetsOf(seeded), true);
  assert.deepEqual(second, { requested: 6, matched: 6, changed: 0, missing: 0 });
  assert.equal(await readFile(joinedRoomsPath(home), "utf8"), contentsAfterFirst);
});

test("an empty selection is a no-op that touches nothing", async () => {
  const home = await makeHome();
  await seedFixture(home, 4);
  const before = await readFile(joinedRoomsPath(home), "utf8");
  assert.deepEqual(await setJoinedRoomsArchived(home, [], true), {
    requested: 0,
    matched: 0,
    changed: 0,
    missing: 0
  });
  assert.deepEqual(await deleteJoinedRooms(home, []), { requested: 0, matched: 0, changed: 0, missing: 0 });
  assert.equal(await readFile(joinedRoomsPath(home), "utf8"), before);
});

test("a bulk batch is one atomic write: the store is never observed half-applied", async () => {
  const home = await makeHome();
  const seeded = await seedFixture(home);
  const selected = seeded.filter((_room, index) => index % 3 === 0);
  const selectedKeys = new Set(selected.map(keyOf));

  // Poll the file while the batch runs. Every readable state must be either the
  // full pre-batch list or the full post-batch list — never a mixture, which is
  // what a per-row loop of single-row writes would expose.
  let observations = 0;
  let mixed = 0;
  let racing = true;
  const watcher = (async () => {
    while (racing) {
      let parsed: { rooms?: JoinedRoom[] };
      try {
        parsed = JSON.parse(await readFile(joinedRoomsPath(home), "utf8")) as { rooms?: JoinedRoom[] };
      } catch {
        continue; // mid-rename: the atomic replace makes this window vanishingly small
      }
      const rooms = parsed.rooms ?? [];
      if (rooms.length === 0) continue;
      observations += 1;
      const archivedSelected = rooms.filter((room) => selectedKeys.has(keyOf(room)) && room.archived === true).length;
      const anyBystanderArchived = rooms.some((room) => !selectedKeys.has(keyOf(room)) && room.archived === true);
      const consistent =
        (archivedSelected === 0 || archivedSelected === selected.length) && !anyBystanderArchived;
      if (!consistent) mixed += 1;
    }
  })();

  await setJoinedRoomsArchived(home, targetsOf(selected), true);
  racing = false;
  await watcher;

  // Positive control: if the watcher never actually read the file, "0 mixed
  // states" would be meaningless — this is the instrument check.
  assert.ok(observations > 0, "the watcher must have read the store at least once");
  assert.equal(mixed, 0, `observed ${mixed} half-applied states across ${observations} reads`);

  const after = await readJoinedRooms(home);
  assert.equal(after.filter((room) => room.archived === true).length, selected.length);
});

test("a concurrent single-row write is serialised, not lost, by the shared writer lock", async () => {
  const home = await makeHome();
  const seeded = await seedFixture(home, 20);
  const bulkTargets = targetsOf(seeded.slice(0, 10));
  const latecomer = syntheticRoom(500);

  // Fire the bulk archive and an unrelated record at the same time. Both go
  // through joinedRoomsLockPath, so neither may read a stale list and drop the
  // other's edit.
  await Promise.all([setJoinedRoomsArchived(home, bulkTargets, true), recordJoinedRoom(home, latecomer)]);

  const after = await readJoinedRooms(home);
  assert.equal(after.length, 21, "the concurrent insert must survive the bulk write");
  assert.ok(
    after.some((room) => room.roomId === latecomer.roomId),
    "the concurrently recorded room must still be present"
  );
  assert.equal(after.filter((room) => room.archived === true).length, 10);
});
