// #277 — the loopback bulk archive/delete endpoints for device-local joined rooms.
//
// The joined-rooms list under test is ALWAYS a synthetic fixture built here (60+
// rooms pointing at loopback ports this test never binds and never contacts). No
// test touches a real joined-rooms list, and no request in this file leaves the
// platform fixture it started itself.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { request, type Server } from "node:http";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlatformHttpServer } from "../src/platform/index.js";
import { readJoinedRooms, recordJoinedRoom, type JoinedRoom } from "../src/storage/index.js";
import { closeServer } from "./support/close-server.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-joined-bulk-http-test-"));
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startServer(root: string): Promise<{ baseUrl: string; close: () => Promise<void>; server: Server }> {
  const server = createPlatformHttpServer({ root, ownerUserId: "owner-1" });
  const port = await getFreePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${port}`, server, close: () => closeServer(server) };
}

function post(
  baseUrl: string,
  pathname: string,
  origin: string,
  body: string
): Promise<{ status: number; body: string }> {
  const url = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { origin, "content-type": "application/json" }
      },
      (res) => {
        let payload = "";
        res.on("data", (chunk) => {
          payload += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: payload }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function syntheticRoom(index: number): JoinedRoom {
  const stamp = new Date(Date.UTC(2026, 0, 1, 0, index % 60)).toISOString();
  return {
    roomId: `synthetic-room-${String(index).padStart(3, "0")}`,
    title: `Synthetic Room ${index}`,
    alias: "operator",
    baseUrl: `http://127.0.0.1:${9000 + index}`,
    joinedAt: stamp,
    lastSeen: stamp
  };
}

async function seedFixture(root: string, size: number): Promise<JoinedRoom[]> {
  const rooms: JoinedRoom[] = [];
  for (let index = 0; index < size; index += 1) {
    const room = syntheticRoom(index);
    rooms.push(room);
    await recordJoinedRoom(root, room);
  }
  return rooms;
}

const targetsOf = (rooms: JoinedRoom[]): { roomId: string; baseUrl: string }[] =>
  rooms.map((room) => ({ roomId: room.roomId, baseUrl: room.baseUrl }));

test("bulk archive applies to exactly the posted targets over a 63-room synthetic list (#277)", async () => {
  const root = await makeRoot();
  const seeded = await seedFixture(root, 63);
  const fixture = await startServer(root);
  try {
    const selected = seeded.filter((_room, index) => index % 4 === 1);
    const res = await post(
      fixture.baseUrl,
      "/joined-rooms/archive-bulk",
      fixture.baseUrl,
      JSON.stringify({ targets: targetsOf(selected), archived: true })
    );
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body) as Record<string, unknown>;
    assert.deepEqual(payload, {
      ok: true,
      requested: selected.length,
      matched: selected.length,
      changed: selected.length,
      missing: 0
    });

    const after = await readJoinedRooms(root);
    const selectedKeys = new Set(selected.map((room) => `${room.roomId}|${room.baseUrl}`));
    assert.equal(after.length, 63, "no row may be added or removed by an archive");
    for (const room of after) {
      const key = `${room.roomId}|${room.baseUrl}`;
      if (selectedKeys.has(key)) assert.equal(room.archived, true);
      else assert.equal("archived" in room, false, `${room.roomId} was not selected and must be untouched`);
    }
  } finally {
    await fixture.close();
  }
});

test("bulk delete removes exactly the posted targets and every other row survives unchanged (#277)", async () => {
  const root = await makeRoot();
  const seeded = await seedFixture(root, 63);
  const before = await readJoinedRooms(root);
  const fixture = await startServer(root);
  try {
    const selected = seeded.filter((_room, index) => index % 6 === 5);
    const res = await post(
      fixture.baseUrl,
      "/joined-rooms/delete-bulk",
      fixture.baseUrl,
      JSON.stringify({ targets: targetsOf(selected) })
    );
    assert.equal(res.status, 200);
    assert.equal((JSON.parse(res.body) as { changed: number }).changed, selected.length);

    const after = await readJoinedRooms(root);
    const selectedKeys = new Set(selected.map((room) => `${room.roomId}|${room.baseUrl}`));
    const survivors = before.filter((room) => !selectedKeys.has(`${room.roomId}|${room.baseUrl}`));
    // Present AND unchanged, in the same order — not merely "the selected ones are gone".
    assert.deepEqual(after, survivors);
  } finally {
    await fixture.close();
  }
});

test("bulk endpoints reject a non-loopback Origin and change nothing (#277)", async () => {
  const root = await makeRoot();
  const seeded = await seedFixture(root, 8);
  const fixture = await startServer(root);
  try {
    for (const pathname of ["/joined-rooms/archive-bulk", "/joined-rooms/delete-bulk"]) {
      const res = await post(
        fixture.baseUrl,
        pathname,
        "https://evil.example",
        JSON.stringify({ targets: targetsOf(seeded), archived: true })
      );
      assert.equal(res.status, 403, `${pathname} must refuse a cross-origin caller`);
      assert.equal((JSON.parse(res.body) as { error: string }).error, "bad_origin");
    }
    // The store is the proof: a refused request must not have applied anything.
    const after = await readJoinedRooms(root);
    assert.equal(after.length, 8);
    assert.equal(after.some((room) => room.archived === true), false);
  } finally {
    await fixture.close();
  }
});

test("one malformed target rejects the whole batch rather than acting on a subset (#277)", async () => {
  const root = await makeRoot();
  const seeded = await seedFixture(root, 10);
  const fixture = await startServer(root);
  try {
    const targets = [...targetsOf(seeded.slice(0, 3)), { roomId: "no-base-url" }];
    const res = await post(
      fixture.baseUrl,
      "/joined-rooms/delete-bulk",
      fixture.baseUrl,
      JSON.stringify({ targets })
    );
    assert.equal(res.status, 400);
    assert.equal((JSON.parse(res.body) as { error: string }).error, "invalid_target");
    // Nothing partially applied: a bulk delete that cannot be fully validated must
    // not delete the entries it happened to parse first.
    assert.equal((await readJoinedRooms(root)).length, 10);
  } finally {
    await fixture.close();
  }
});

test("bulk endpoints reject an empty, oversized, or non-array target list (#277)", async () => {
  const root = await makeRoot();
  await seedFixture(root, 4);
  const fixture = await startServer(root);
  try {
    const cases: { body: string; error: string }[] = [
      { body: JSON.stringify({ targets: [] }), error: "invalid_targets" },
      { body: JSON.stringify({ targets: "everything" }), error: "invalid_targets" },
      { body: JSON.stringify({}), error: "invalid_targets" },
      {
        body: JSON.stringify({
          targets: Array.from({ length: 501 }, (_value, index) => ({
            roomId: `bulk-${index}`,
            baseUrl: `http://127.0.0.1:${9000 + index}`
          }))
        }),
        error: "too_many_targets"
      },
      { body: "{not json", error: "invalid_json" }
    ];
    for (const testCase of cases) {
      const res = await post(fixture.baseUrl, "/joined-rooms/delete-bulk", fixture.baseUrl, testCase.body);
      assert.equal(res.status, 400);
      assert.equal((JSON.parse(res.body) as { error: string }).error, testCase.error);
    }
    assert.equal((await readJoinedRooms(root)).length, 4);
  } finally {
    await fixture.close();
  }
});

test("bulk responses are token-free and carry no room identifiers back (#277)", async () => {
  const root = await makeRoot();
  const seeded = await seedFixture(root, 12);
  const fixture = await startServer(root);
  try {
    const res = await post(
      fixture.baseUrl,
      "/joined-rooms/archive-bulk",
      fixture.baseUrl,
      JSON.stringify({ targets: targetsOf(seeded.slice(0, 4)), archived: true })
    );
    assert.equal(res.status, 200);
    // Counts only. No token shape, no invite/card URL, no host, no room id, and no
    // filesystem path may appear in a response backing this view.
    assert.equal(/tgl_|Bearer|"token"|invite|card/i.test(res.body), false, "response must be token-free");
    assert.equal(/synthetic-room|127\.0\.0\.1|\/tmp|\/home/.test(res.body), false, "response must not echo targets");
    assert.deepEqual(Object.keys(JSON.parse(res.body) as Record<string, unknown>).sort(), [
      "changed",
      "matched",
      "missing",
      "ok",
      "requested"
    ]);
  } finally {
    await fixture.close();
  }
});

test("a full 63-room selection with realistic-length room ids is accepted, not rejected as malformed (#277)", async () => {
  // Regression for the defect this suite found: the bulk routes originally
  // inherited the 8 KiB single-post body cap, so selecting the operator's whole
  // list — room ids run to the 200-char sanitizer limit — overflowed it and came
  // back as "body must be JSON". A size ceiling that misreports itself as a
  // parse error is worse than the ceiling.
  const root = await makeRoot();
  const rooms: JoinedRoom[] = [];
  for (let index = 0; index < 63; index += 1) {
    const room: JoinedRoom = {
      roomId: `${"long-synthetic-room-id-".repeat(8)}${String(index).padStart(3, "0")}`.slice(0, 200),
      title: `Synthetic Room ${index}`,
      alias: "operator",
      baseUrl: `http://127.0.0.1:${9000 + index}`,
      joinedAt: new Date(0).toISOString(),
      lastSeen: new Date(0).toISOString()
    };
    rooms.push(room);
    await recordJoinedRoom(root, room);
  }
  const payload = JSON.stringify({ targets: targetsOf(rooms), archived: true });
  // The instrument check: this body must actually exceed the old 8 KiB cap, or
  // the regression it guards would pass against the unfixed code too.
  assert.ok(Buffer.byteLength(payload) > 8_192, "fixture body must exceed the old default cap");

  const fixture = await startServer(root);
  try {
    const res = await post(fixture.baseUrl, "/joined-rooms/archive-bulk", fixture.baseUrl, payload);
    assert.equal(res.status, 200, `a full-list selection must be accepted, got ${res.body}`);
    assert.equal((JSON.parse(res.body) as { changed: number }).changed, 63);
    assert.equal((await readJoinedRooms(root)).filter((room) => room.archived === true).length, 63);
  } finally {
    await fixture.close();
  }
});

test("a body beyond the bulk cap is refused as too large, not as malformed JSON (#277)", async () => {
  const root = await makeRoot();
  await seedFixture(root, 2);
  const fixture = await startServer(root);
  try {
    const oversized = JSON.stringify({
      targets: [{ roomId: "x".repeat(300_000), baseUrl: "http://127.0.0.1:9000" }]
    });
    const res = await post(fixture.baseUrl, "/joined-rooms/delete-bulk", fixture.baseUrl, oversized);
    assert.equal(res.status, 413);
    assert.equal((JSON.parse(res.body) as { error: string }).error, "body_too_large");
    assert.equal((await readJoinedRooms(root)).length, 2);
  } finally {
    await fixture.close();
  }
});
