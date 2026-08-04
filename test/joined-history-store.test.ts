// #247 — the dashboard-owned offline snapshot store. These are the invariants the
// browser and platform layers rely on: nothing credential-shaped survives a write,
// the file cannot grow without bound, its path cannot be steered by a hostile room
// id, concurrent writers do not lose each other's batches, and archive/delete
// really removes the saved transcript.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deleteJoinedRoom,
  joinedHistoryDir,
  joinedHistoryPath,
  readJoinedHistory,
  recordJoinedHistory,
  recordJoinedRoom,
  setJoinedRoomArchived,
  SNAPSHOT_MAX_MESSAGES,
  SNAPSHOT_MAX_TEXT_CHARS
} from "../src/storage/index.js";

async function makeHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-joined-history-test-"));
}

const KEY = { roomId: "snap-room", baseUrl: "http://127.0.0.1:9" };

function message(id: number, text: string): { id: number; from: string; ts: string; type: string; text: string } {
  return { id, from: "project7", ts: "2026-08-04T00:00:00.000Z", type: "chat", text };
}

test("a snapshot keeps only already-received messages, de-duped by id and ordered (#247)", async () => {
  const home = await makeHome();
  await recordJoinedHistory(home, { ...KEY, messages: [message(2, "second"), message(1, "first")], savedAt: "2026-08-04T00:00:00.000Z" });
  // A reconnect re-delivers an overlapping range — the transcript must not double up.
  await recordJoinedHistory(home, { ...KEY, messages: [message(2, "second"), message(3, "third")], savedAt: "2026-08-04T00:01:00.000Z" });

  const snapshot = await readJoinedHistory(home, KEY);
  assert.deepEqual(snapshot?.messages.map((entry) => entry.id), [1, 2, 3]);
  assert.deepEqual(snapshot?.messages.map((entry) => entry.text), ["first", "second", "third"]);
  // The cursor is what the offline view is allowed to claim it holds.
  assert.equal(snapshot?.cursor, 3);
  assert.equal(snapshot?.savedAt, "2026-08-04T00:01:00.000Z");
});

test("a snapshot never persists a bearer token, tgl_ token, token= param, card URL, or bridge capability (#247)", async () => {
  const home = await makeHome();
  await recordJoinedHistory(home, {
    ...KEY,
    messages: [
      message(1, "join with tgl_secret_participant_value"),
      message(2, "Authorization: Bearer abc.def.ghi"),
      message(3, "open http://host.test/room?token=tgl_leaky#token=tgl_leaky"),
      message(4, "card at http://host.test/card/abc"),
      message(5, "bridge http://127.0.0.1:9/x?snapshot=cap-value-here")
    ],
    savedAt: "2026-08-04T00:00:00.000Z"
  });

  const raw = await readFile(joinedHistoryPath(home, KEY), "utf8");
  assert.equal(/tgl_|Bearer |token=|snapshot=|\/card\//i.test(raw), false);
  assert.match(raw, /\[redacted-token\]/);
  assert.match(raw, /\[redacted-credential\]/);
  assert.match(raw, /\[redacted-url\]/);
  // The surrounding prose survives — redaction is targeted, not a blanket drop.
  assert.match(raw, /join with/);
});

test("a snapshot is bounded by message count, per-field length, and total bytes (#247)", async () => {
  const home = await makeHome();
  const many = Array.from({ length: SNAPSHOT_MAX_MESSAGES + 40 }, (_, index) => message(index + 1, `line ${index + 1}`));
  await recordJoinedHistory(home, { ...KEY, messages: many, savedAt: "2026-08-04T00:00:00.000Z" });

  let snapshot = await readJoinedHistory(home, KEY);
  assert.equal(snapshot?.messages.length, SNAPSHOT_MAX_MESSAGES);
  // Oldest dropped first, and the cursor still names what actually survived.
  assert.equal(snapshot?.messages[0]?.id, 41);
  assert.equal(snapshot?.cursor, SNAPSHOT_MAX_MESSAGES + 40);

  // A single enormous message cannot blow the file past its cap either.
  await recordJoinedHistory(home, {
    ...KEY,
    messages: [message(9_999, "x".repeat(50_000))],
    savedAt: "2026-08-04T00:02:00.000Z"
  });
  snapshot = await readJoinedHistory(home, KEY);
  const stored = snapshot?.messages.find((entry) => entry.id === 9_999);
  assert.equal(stored?.text.length, SNAPSHOT_MAX_TEXT_CHARS);
  const size = (await stat(joinedHistoryPath(home, KEY))).size;
  assert.equal(size < 260_000, true, `snapshot stayed bounded (${size} bytes)`);
});

test("a hostile room id or base URL cannot steer the snapshot outside its directory (#247)", async () => {
  const home = await makeHome();
  const hostile = { roomId: "../../../../etc/passwd", baseUrl: "http://127.0.0.1:9/../../.." };
  await recordJoinedHistory(home, { ...hostile, messages: [message(1, "hostile")], savedAt: "2026-08-04T00:00:00.000Z" });

  const file = joinedHistoryPath(home, hostile);
  assert.equal(path.dirname(file), joinedHistoryDir(home));
  assert.equal(path.basename(file).includes("/"), false);
  assert.match(path.basename(file), /^[0-9a-f]{64}\.json$/);
  // Everything written lives under the snapshot directory, nowhere else.
  const entries = await readdir(joinedHistoryDir(home));
  assert.equal(entries.every((name) => /^[0-9a-f]{64}\.json/.test(name)), true);
  // ...and it is still readable back under the same hostile key, not silently lost.
  assert.equal((await readJoinedHistory(home, hostile))?.messages.length, 1);
});

test("snapshots are keyed per (roomId, baseUrl) — a same-id room on another host is separate (#247)", async () => {
  const home = await makeHome();
  await recordJoinedHistory(home, { ...KEY, messages: [message(1, "host A line")], savedAt: "2026-08-04T00:00:00.000Z" });
  const other = { roomId: "snap-room", baseUrl: "http://127.0.0.1:8" };
  await recordJoinedHistory(home, { ...other, messages: [message(1, "host B line")], savedAt: "2026-08-04T00:00:00.000Z" });

  assert.equal((await readJoinedHistory(home, KEY))?.messages[0]?.text, "host A line");
  assert.equal((await readJoinedHistory(home, other))?.messages[0]?.text, "host B line");
});

test("concurrent snapshot writes are serialized — no batch is lost (#247)", async () => {
  const home = await makeHome();
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      recordJoinedHistory(home, {
        ...KEY,
        messages: [message(index + 1, `concurrent ${index + 1}`)],
        savedAt: "2026-08-04T00:00:00.000Z"
      })
    )
  );
  const snapshot = await readJoinedHistory(home, KEY);
  assert.deepEqual(
    snapshot?.messages.map((entry) => entry.id),
    [1, 2, 3, 4, 5, 6, 7, 8]
  );
});

test("a re-opened forum thread replaces its feed row and keeps its comments (#247)", async () => {
  const home = await makeHome();
  await recordJoinedHistory(home, {
    ...KEY,
    forumPosts: [{ id: "p1", channel: "design", title: "Feed row", author: "project7", ts: "", status: "open", body: "body", comments: [] }],
    savedAt: "2026-08-04T00:00:00.000Z"
  });
  await recordJoinedHistory(home, {
    ...KEY,
    forumPosts: [
      {
        id: "p1",
        channel: "design",
        title: "Feed row",
        author: "project7",
        ts: "",
        status: "open",
        body: "body",
        comments: [{ id: "c1", author: "agent-bot", ts: "", body: "a comment with tgl_secret_value_here" }]
      }
    ],
    savedAt: "2026-08-04T00:01:00.000Z"
  });

  const snapshot = await readJoinedHistory(home, KEY);
  assert.equal(snapshot?.forumPosts.length, 1);
  assert.equal(snapshot?.forumPosts[0]?.comments.length, 1);
  // Comment bodies are redacted like message text.
  assert.equal(/tgl_/.test(snapshot?.forumPosts[0]?.comments[0]?.body ?? ""), false);

  // A later feed-only load must not wipe the comments the thread view captured.
  await recordJoinedHistory(home, {
    ...KEY,
    forumPosts: [{ id: "p1", channel: "design", title: "Feed row", author: "project7", ts: "", status: "open", body: "body", comments: [] }],
    savedAt: "2026-08-04T00:02:00.000Z"
  });
  assert.equal((await readJoinedHistory(home, KEY))?.forumPosts[0]?.comments.length, 1);
});

test("archiving or deleting a joined room removes its saved transcript (#247/#210)", async () => {
  const home = await makeHome();
  const now = "2026-08-04T00:00:00.000Z";
  const row = { roomId: KEY.roomId, title: "Snapshot Room", alias: "project7", baseUrl: KEY.baseUrl, joinedAt: now, lastSeen: now };
  await recordJoinedRoom(home, row);
  await recordJoinedHistory(home, { ...KEY, messages: [message(1, "saved line")], savedAt: now });
  assert.notEqual(await readJoinedHistory(home, KEY), null);

  assert.equal(await setJoinedRoomArchived(home, { ...KEY, archived: true }), true);
  assert.equal(await readJoinedHistory(home, KEY), null, "archive drops the snapshot");

  // And a delete on a fresh snapshot removes it too.
  await recordJoinedHistory(home, { ...KEY, messages: [message(1, "saved again")], savedAt: now });
  assert.equal(await deleteJoinedRoom(home, KEY), true);
  assert.equal(await readJoinedHistory(home, KEY), null, "delete drops the snapshot");
});

test("a missing or corrupt snapshot reads as absent rather than throwing (#247)", async () => {
  const home = await makeHome();
  assert.equal(await readJoinedHistory(home, KEY), null);

  const { writeSecureFile } = await import("../src/storage/index.js");
  await writeSecureFile(joinedHistoryPath(home, KEY), "{ not json");
  assert.equal(await readJoinedHistory(home, KEY), null);

  // A snapshot whose stored key does not match the requested one is not served.
  await writeSecureFile(
    joinedHistoryPath(home, KEY),
    JSON.stringify({ roomId: "other", baseUrl: KEY.baseUrl, cursor: 1, savedAt: "", messages: [], forumPosts: [] })
  );
  assert.equal(await readJoinedHistory(home, KEY), null);
});
