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
  readJoinedRooms,
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

  const snapshot = (await readJoinedHistory(home, KEY)).snapshot;
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

  let snapshot = (await readJoinedHistory(home, KEY)).snapshot;
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
  snapshot = (await readJoinedHistory(home, KEY)).snapshot;
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
  assert.equal((await readJoinedHistory(home, hostile)).snapshot?.messages.length, 1);
});

test("snapshots are keyed per (roomId, baseUrl) — a same-id room on another host is separate (#247)", async () => {
  const home = await makeHome();
  await recordJoinedHistory(home, { ...KEY, messages: [message(1, "host A line")], savedAt: "2026-08-04T00:00:00.000Z" });
  const other = { roomId: "snap-room", baseUrl: "http://127.0.0.1:8" };
  await recordJoinedHistory(home, { ...other, messages: [message(1, "host B line")], savedAt: "2026-08-04T00:00:00.000Z" });

  assert.equal((await readJoinedHistory(home, KEY)).snapshot?.messages[0]?.text, "host A line");
  assert.equal((await readJoinedHistory(home, other)).snapshot?.messages[0]?.text, "host B line");
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
  const snapshot = (await readJoinedHistory(home, KEY)).snapshot;
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

  const snapshot = (await readJoinedHistory(home, KEY)).snapshot;
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
  assert.equal((await readJoinedHistory(home, KEY)).snapshot?.forumPosts[0]?.comments.length, 1);
});

test("archive keeps the saved transcript and un-archive restores it; delete clears it (#247/#210)", async () => {
  const home = await makeHome();
  const now = "2026-08-04T00:00:00.000Z";
  const row = { roomId: KEY.roomId, title: "Snapshot Room", alias: "project7", baseUrl: KEY.baseUrl, joinedAt: now, lastSeen: now };
  await recordJoinedRoom(home, row);
  await recordJoinedHistory(home, { ...KEY, messages: [message(1, "saved line")], savedAt: now });
  assert.equal((await readJoinedHistory(home, KEY)).state, "ok");

  // Archive is a reversible hide: the transcript must survive it, and un-archiving
  // must restore a readable row (PO ruling on #247; #210 defines archive as
  // recoverable, and a lost host transcript cannot be rebuilt from anywhere).
  assert.equal(await setJoinedRoomArchived(home, { ...KEY, archived: true }), true);
  assert.equal((await readJoinedHistory(home, KEY)).snapshot?.messages[0]?.text, "saved line", "archive keeps the snapshot");
  assert.equal(await setJoinedRoomArchived(home, { ...KEY, archived: false }), true);
  assert.equal((await readJoinedHistory(home, KEY)).snapshot?.messages[0]?.text, "saved line", "un-archive restores it");

  // Delete is the explicit destructive action and does clear it.
  assert.equal(await deleteJoinedRoom(home, KEY), true);
  assert.deepEqual(await readJoinedHistory(home, KEY), { state: "absent", snapshot: null }, "delete drops the snapshot");
});

test("a missing snapshot reads as absent, a damaged one as unreadable (#247/#293)", async () => {
  // This test previously asserted that a corrupt snapshot "reads as absent" —
  // it encoded the very conflation #293 exists to remove. A host log can be
  // re-fetched; a snapshot cannot, so absence and damage are different facts and
  // the user can only act on the second one while the host is still reachable.
  const home = await makeHome();
  assert.deepEqual(
    await readJoinedHistory(home, KEY),
    { state: "absent", snapshot: null },
    "a room never opened offline is the ordinary case, and stays absent"
  );

  const { writeSecureFile } = await import("../src/storage/index.js");
  await writeSecureFile(joinedHistoryPath(home, KEY), "{ not json");
  assert.deepEqual(
    await readJoinedHistory(home, KEY),
    { state: "unreadable", snapshot: null },
    "truncated or hand-edited JSON is unreadable, not absent"
  );

  // A snapshot whose stored key does not match the requested one is not served —
  // and is not absence either: the file exists and is not what it claims.
  await writeSecureFile(
    joinedHistoryPath(home, KEY),
    JSON.stringify({ roomId: "other", baseUrl: KEY.baseUrl, cursor: 1, savedAt: "", messages: [], forumPosts: [] })
  );
  assert.deepEqual(await readJoinedHistory(home, KEY), { state: "unreadable", snapshot: null });

  // Still non-fatal: every one of the reads above returned rather than threw, and
  // a valid snapshot written afterwards reads back normally — one damaged file
  // does not poison the reader.
  await recordJoinedHistory(home, { roomId: KEY.roomId, baseUrl: KEY.baseUrl, savedAt: new Date(0).toISOString(), messages: [message(1, "recovered")] });
  const after = await readJoinedHistory(home, KEY);
  assert.equal(after.state, "ok");
  assert.equal(after.snapshot?.messages[0]?.text, "recovered");
});

// #247 (@re1) — cleanup and the bridge write must not interleave. Archive/delete
// changes the row first and removes the snapshot under the SAME writer lock the
// write takes, and the write re-checks the row inside that lock. The invariant
// these tests hold: a snapshot never outlives the row it belongs to.
test("a bridge write refused by its in-lock guard stores nothing (#247)", async () => {
  const home = await makeHome();
  const stored = await recordJoinedHistory(
    home,
    { ...KEY, messages: [message(1, "should not land")], savedAt: "2026-08-04T00:00:00.000Z" },
    async () => false
  );
  assert.equal(stored, null);
  assert.deepEqual(await readJoinedHistory(home, KEY), { state: "absent", snapshot: null });
});


// #247 (@re1) — the delete/write race, forced rather than hoped for. The bridge
// write is held INSIDE the snapshot writer lock while the delete completes its row
// removal, which is exactly the window where a pre-accepted post could otherwise
// land after deletion returned. With the in-lock re-check the write must refuse;
// without it, this test fails with a snapshot for a row that no longer exists.
test("a bridge write accepted before deletion cannot land after it (#247)", async () => {
  const home = await makeHome();
  const now = "2026-08-04T00:00:00.000Z";
  await recordJoinedRoom(home, {
    roomId: KEY.roomId,
    title: "Snapshot Room",
    alias: "project7",
    baseUrl: KEY.baseUrl,
    joinedAt: now,
    lastSeen: now
  });
  await recordJoinedHistory(home, { ...KEY, messages: [message(1, "earlier line")], savedAt: now });

  let announceInLock = (): void => {};
  const inLock = new Promise<void>((resolve) => {
    announceInLock = resolve;
  });
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  // The receiver's real predicate: still tracked and not archived, re-read from disk.
  const guard = async (): Promise<boolean> => {
    announceInLock();
    await held;
    const rooms = await readJoinedRooms(home);
    const row = rooms.find((entry) => entry.roomId === KEY.roomId && entry.baseUrl === KEY.baseUrl);
    return row !== undefined && row.archived !== true;
  };

  const write = recordJoinedHistory(home, { ...KEY, messages: [message(2, "racing line")], savedAt: now }, guard);
  await inLock; // the write now holds the snapshot lock
  const deletion = deleteJoinedRoom(home, KEY);
  // Wait until the row itself is gone — the delete's snapshot removal is still
  // queued behind the lock this write is holding.
  for (let attempt = 0; attempt < 200 && (await readJoinedRooms(home)).length > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await readJoinedRooms(home)).length, 0, "the row was removed while the write held the lock");
  release();

  assert.equal(await write, null, "the in-lock re-check refused the write");
  assert.equal(await deletion, true);
  assert.deepEqual(await readJoinedHistory(home, KEY), { state: "absent", snapshot: null }, "no snapshot outlived the deleted row");
});

// #247 (@re2/@re1) — redaction covers EVERY persisted string, not just bodies. A
// participant aliased after a card URL, or a credential-shaped timestamp/type/
// status, must not reach disk: these fields are rendered in the dashboard.
test("every persisted field is redacted, not only message and post bodies (#247)", async () => {
  const home = await makeHome();
  await recordJoinedHistory(home, {
    ...KEY,
    messages: [
      {
        id: 1,
        from: "https://evil.example/card/abc123?token=tgl_leaked_secret_value",
        ts: "Bearer sk-live-abcdef",
        type: "tgl_type_secret_value",
        text: "ordinary body"
      }
    ],
    forumPosts: [
      {
        id: "tgl_post_id_secret_value",
        channel: "https://evil.example/card/xyz",
        title: "ordinary title",
        author: "https://evil.example/card/abc123",
        ts: "Bearer sk-live-fedcba",
        status: "tgl_status_secret_value",
        body: "ordinary post body",
        comments: [
          { id: "tgl_comment_id_secret", author: "Bearer sk-live-comment", ts: "?token=tgl_comment_ts", body: "ordinary comment" }
        ]
      }
    ],
    savedAt: "2026-08-04T00:00:00.000Z"
  });

  // Exact expected values, not merely "the raw token is missing".
  const snapshot = (await readJoinedHistory(home, KEY)).snapshot;
  assert.equal(snapshot?.messages[0]?.from, "[redacted-url]");
  assert.equal(snapshot?.messages[0]?.ts, "[redacted-credential]");
  assert.equal(snapshot?.messages[0]?.type, "[redacted-token]");
  const post = snapshot?.forumPosts[0];
  assert.equal(post?.id, "[redacted-token]");
  assert.equal(post?.channel, "[redacted-url]");
  assert.equal(post?.author, "[redacted-url]");
  assert.equal(post?.ts, "[redacted-credential]");
  assert.equal(post?.status, "[redacted-token]");
  assert.equal(post?.comments[0]?.id, "[redacted-token]");
  assert.equal(post?.comments[0]?.author, "[redacted-credential]");
  assert.equal(post?.comments[0]?.ts, "[redacted-token]");
  // Ordinary content is untouched, and the raw file carries nothing sensitive.
  assert.equal(snapshot?.messages[0]?.text, "ordinary body");
  const raw = await readFile(joinedHistoryPath(home, KEY), "utf8");
  assert.equal(/tgl_|Bearer |token=|evil\.example/i.test(raw), false);
});

// #247 (@re2) — the byte cap must describe the file that is actually written:
// pretty-printed, UTF-8, including multi-byte content.
test("the byte cap measures the pretty-printed file, including multi-byte text (#247)", async () => {
  const home = await makeHome();
  await recordJoinedHistory(home, {
    ...KEY,
    // CJK content is 3 bytes per character — a character-counted cap would let the
    // real file run several times past its stated ceiling.
    messages: Array.from({ length: 400 }, (_, index) => message(index + 1, "가".repeat(1_000))),
    savedAt: "2026-08-04T00:00:00.000Z"
  });
  const size = (await stat(joinedHistoryPath(home, KEY))).size;
  assert.equal(size <= 200_000, true, `snapshot file stayed within its byte cap (${size} bytes)`);
});
