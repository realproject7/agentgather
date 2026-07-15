import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJoinedRooms, recordJoinedRoom } from "../src/storage/index.js";
import { readToken, writeToken } from "../src/cli/state.js";

async function makeHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-rmw-test-"));
}

// Without a writer lock, two concurrent read-modify-writes both read the old
// store and the last writer clobbers the other's entry. The lock serializes the
// whole RMW so every distinct entry survives.
test("concurrent writeToken for distinct aliases keeps every token", async () => {
  const home = await makeHome();
  const roomId = "ag-room-0001";
  const count = 12;

  await Promise.all(
    Array.from({ length: count }, (_, i) => writeToken(home, roomId, `alias-${i}`, `token-${i}`))
  );

  for (let i = 0; i < count; i += 1) {
    assert.equal(await readToken(home, roomId, `alias-${i}`), `token-${i}`);
  }
});

test("concurrent recordJoinedRoom for distinct rooms keeps every entry", async () => {
  const home = await makeHome();
  const count = 12;

  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      recordJoinedRoom(home, {
        roomId: `ag-room-${i}`,
        title: `Room ${i}`,
        alias: "me",
        baseUrl: `http://host-${i}.local`,
        joinedAt: "2026-07-14T00:00:00.000Z",
        lastSeen: "2026-07-14T00:00:00.000Z"
      })
    )
  );

  const rooms = await readJoinedRooms(home);
  assert.equal(rooms.length, count);
  const ids = new Set(rooms.map((room) => room.roomId));
  for (let i = 0; i < count; i += 1) {
    assert.ok(ids.has(`ag-room-${i}`), `missing ag-room-${i}`);
  }
});
