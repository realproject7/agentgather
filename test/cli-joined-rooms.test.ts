import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { joinedRoomsPath, readJoinedRooms } from "../src/storage/index.js";

function makeCtx(home: string): CliContext {
  return { home, stdout: { write: () => {} }, stderr: { write: () => {} } } as unknown as CliContext;
}

// #254: `room join` probes GET /status on the room's base URL — with the
// participant token in an Authorization header — to hydrate a display title.
// Pointed at the product default port that header went to whatever process owned
// 127.0.0.1:8787. This listener is bound by the test itself and answers 404, so
// the join keeps its documented offline fallback (title = room id) and the
// request can never leave for a room the test does not own.
async function startTitleProbeListener(): Promise<{
  baseUrl: string;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server = createHttpServer((req, res) => {
    requests.push(req.url ?? "");
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Drop keep-alive sockets the client left open; otherwise close() waits
        // on them and the test process lingers after its assertions finish.
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  };
}

test("room join records a device-local joined-room entry with NO token (#178)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agentgather-joined-cli-"));
  const token = "tgl_secret_abc123XYZ";
  const probe = await startTitleProbeListener();
  try {
    const code = await runRoomCommand(
      ["join", "demo-room", "--alias", "me", "--token", token, "--url", probe.baseUrl, "--json"],
      makeCtx(home)
    );
    assert.equal(code, 0);

    const rooms = await readJoinedRooms(home);
    assert.equal(rooms.length, 1);
    const entry = rooms[0];
    assert.ok(entry);
    assert.equal(entry.roomId, "demo-room");
    assert.equal(entry.alias, "me");
    assert.equal(entry.baseUrl, probe.baseUrl);
    assert.ok(entry.joinedAt);
    assert.ok(entry.lastSeen);
    // No token field on the record, and the raw file never contains the secret.
    assert.equal("token" in entry, false);
    const raw = await readFile(joinedRoomsPath(home), "utf8");
    assert.equal(/tgl_|Bearer|#token=|secret_abc123/i.test(raw), false);
    // The title probe went to this test's own listener, not to a foreign room.
    assert.deepEqual(probe.requests, ["/status"]);
  } finally {
    await probe.close();
  }
});

test("re-joining the same room updates last_seen and does not duplicate the entry (#178)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agentgather-joined-cli-"));
  const probe = await startTitleProbeListener();
  try {
    await runRoomCommand(
      ["join", "demo-room", "--alias", "me", "--token", "tgl_one", "--url", probe.baseUrl],
      makeCtx(home)
    );
    const first = await readJoinedRooms(home);
    await runRoomCommand(
      ["join", "demo-room", "--alias", "me", "--token", "tgl_two", "--url", probe.baseUrl],
      makeCtx(home)
    );
    const second = await readJoinedRooms(home);
    assert.equal(second.length, 1);
    // joinedAt is preserved; lastSeen advances (or stays equal) — never a token.
    assert.equal(second[0]?.joinedAt, first[0]?.joinedAt);
    const raw = await readFile(joinedRoomsPath(home), "utf8");
    assert.equal(/tgl_/i.test(raw), false);
  } finally {
    await probe.close();
  }
});

test("recordJoinedRoom keeps a known display title and never downgrades it to the slug (#216)", async () => {
  const { recordJoinedRoom } = await import("../src/storage/index.js");
  const home = await mkdtemp(path.join(os.tmpdir(), "agentgather-joined-title-"));
  const base = { roomId: "ag-project-0706", alias: "me", baseUrl: "http://127.0.0.1:8787", joinedAt: "2026-07-01T00:00:00.000Z", lastSeen: "2026-07-01T00:00:00.000Z" };

  // First join hydrated a real display title.
  await recordJoinedRoom(home, { ...base, title: "Agent Gather Launch" });
  assert.equal((await readJoinedRooms(home))[0]?.title, "Agent Gather Launch");

  // A later offline / token-less re-record only carries the slug-like fallback
  // (title === roomId): the known display title must survive.
  await recordJoinedRoom(home, { ...base, title: base.roomId, lastSeen: "2026-07-02T00:00:00.000Z" });
  const after = await readJoinedRooms(home);
  assert.equal(after.length, 1);
  assert.equal(after[0]?.title, "Agent Gather Launch");
  assert.equal(after[0]?.lastSeen, "2026-07-02T00:00:00.000Z");

  // A room that never had a title falls back cleanly to the room id.
  await recordJoinedRoom(home, { roomId: "slug-only", title: "slug-only", alias: "me", baseUrl: "http://127.0.0.1:9", joinedAt: base.joinedAt, lastSeen: base.lastSeen });
  assert.equal((await readJoinedRooms(home)).find((r) => r.roomId === "slug-only")?.title, "slug-only");
});

test("archive round-trips and delete removes ONLY the joined record — host-owned room data survives (#210)", async () => {
  const { createRoom, readBrief, recordJoinedRoom, setJoinedRoomArchived, deleteJoinedRoom } = await import(
    "../src/storage/index.js"
  );
  const home = await mkdtemp(path.join(os.tmpdir(), "agentgather-joined-archive-"));
  const now = "2026-07-01T00:00:00.000Z";

  // A host-owned room lives in the SAME AGENTGATHER_HOME as the joined record.
  await createRoom({ root: home, roomId: "hosted-room", hostAlias: "host", briefBody: "keep me" });
  await recordJoinedRoom(home, { roomId: "joined-room", title: "Joined", alias: "me", baseUrl: "http://127.0.0.1:9", joinedAt: now, lastSeen: now });

  // Archive is recoverable: flag on, then off.
  assert.equal(await setJoinedRoomArchived(home, { roomId: "joined-room", baseUrl: "http://127.0.0.1:9", archived: true }), true);
  assert.equal((await readJoinedRooms(home))[0]?.archived, true);
  await setJoinedRoomArchived(home, { roomId: "joined-room", baseUrl: "http://127.0.0.1:9", archived: false });
  assert.equal((await readJoinedRooms(home))[0]?.archived, undefined);

  // Delete removes the joined record...
  assert.equal(await deleteJoinedRoom(home, { roomId: "joined-room", baseUrl: "http://127.0.0.1:9" }), true);
  assert.equal((await readJoinedRooms(home)).length, 0);
  // ...a second delete is a no-op (nothing left to remove).
  assert.equal(await deleteJoinedRoom(home, { roomId: "joined-room", baseUrl: "http://127.0.0.1:9" }), false);

  // The host-owned room's data is untouched by the joined-room delete.
  assert.equal((await readBrief(home, "hosted-room")).body, "keep me");
  // The joined-rooms store never held a token.
  assert.equal(/tgl_|Bearer|token=/i.test(await readFile(joinedRoomsPath(home), "utf8").catch(() => "")), false);
});
