import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { joinedRoomsPath, readJoinedRooms } from "../src/storage/index.js";

function makeCtx(home: string): CliContext {
  return { home, stdout: { write: () => {} }, stderr: { write: () => {} } } as unknown as CliContext;
}

test("room join records a device-local joined-room entry with NO token (#178)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agentgather-joined-cli-"));
  const token = "tgl_secret_abc123XYZ";
  const code = await runRoomCommand(
    ["join", "demo-room", "--alias", "me", "--token", token, "--url", "http://127.0.0.1:8787", "--json"],
    makeCtx(home)
  );
  assert.equal(code, 0);

  const rooms = await readJoinedRooms(home);
  assert.equal(rooms.length, 1);
  const entry = rooms[0];
  assert.ok(entry);
  assert.equal(entry.roomId, "demo-room");
  assert.equal(entry.alias, "me");
  assert.match(entry.baseUrl, /127\.0\.0\.1:8787/);
  assert.ok(entry.joinedAt);
  assert.ok(entry.lastSeen);
  // No token field on the record, and the raw file never contains the secret.
  assert.equal("token" in entry, false);
  const raw = await readFile(joinedRoomsPath(home), "utf8");
  assert.equal(/tgl_|Bearer|#token=|secret_abc123/i.test(raw), false);
});

test("re-joining the same room updates last_seen and does not duplicate the entry (#178)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agentgather-joined-cli-"));
  await runRoomCommand(
    ["join", "demo-room", "--alias", "me", "--token", "tgl_one", "--url", "http://127.0.0.1:8787"],
    makeCtx(home)
  );
  const first = await readJoinedRooms(home);
  await runRoomCommand(
    ["join", "demo-room", "--alias", "me", "--token", "tgl_two", "--url", "http://127.0.0.1:8787"],
    makeCtx(home)
  );
  const second = await readJoinedRooms(home);
  assert.equal(second.length, 1);
  // joinedAt is preserved; lastSeen advances (or stays equal) — never a token.
  assert.equal(second[0]?.joinedAt, first[0]?.joinedAt);
  const raw = await readFile(joinedRoomsPath(home), "utf8");
  assert.equal(/tgl_/i.test(raw), false);
});
