import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendMessage,
  createRoom,
  MAX_BRIEF_LENGTH,
  readMessages,
  readCursor,
  recoverNextMessageId,
  recoverRoomState,
  roomPaths,
  updateBrief,
  writeCursor,
  writeParticipants
} from "../src/storage/index.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "telegent-test-"));
}

test("createRoom writes the expected room directory layout", async () => {
  const root = await makeRoot();
  const now = new Date("2026-06-21T00:00:00.000Z");
  const state = await createRoom({
    root,
    roomId: "test-room",
    hostAlias: "host",
    briefBody: "Ship the storage layer.",
    now
  });
  const paths = roomPaths(root, "test-room");

  assert.equal(state.id, "test-room");
  assert.equal(state.brief_version, 1);
  assert.match(paths.state, /room\.json$/);
  assert.equal(await readFile(paths.brief, "utf8"), "Ship the storage layer.");
  assert.deepEqual(JSON.parse(await readFile(paths.participants, "utf8")), []);
  assert.equal(await readFile(paths.messages, "utf8"), "");
});

test("createRoom does not overwrite an existing room", async () => {
  const root = await makeRoot();
  await createRoom({
    root,
    roomId: "existing-room",
    hostAlias: "host",
    briefBody: "Original brief"
  });

  await assert.rejects(
    createRoom({
      root,
      roomId: "existing-room",
      hostAlias: "host",
      briefBody: "Replacement brief"
    }),
    /EEXIST/
  );

  const paths = roomPaths(root, "existing-room");
  assert.equal(await readFile(paths.brief, "utf8"), "Original brief");
});


test("appendMessage serializes concurrent writes with monotonic IDs and valid JSONL", async () => {
  const root = await makeRoot();
  await createRoom({ root, roomId: "concurrent-room", hostAlias: "host" });

  const appended = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      appendMessage({
        root,
        roomId: "concurrent-room",
        from: "host",
        input: { text: `message ${index}` }
      })
    )
  );
  const messages = await readMessages(root, "concurrent-room");
  const ids = messages.map((message) => message.id);

  assert.equal(appended.length, 24);
  assert.deepEqual(ids, Array.from({ length: 24 }, (_, index) => index + 1));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(messages.every((message) => message.room === "concurrent-room"), true);
});

test("appendMessage recovers the next ID from existing message history on startup", async () => {
  const root = await makeRoot();
  await createRoom({ root, roomId: "recover-room", hostAlias: "host" });
  const paths = roomPaths(root, "recover-room");
  await appendMessage({ root, roomId: "recover-room", from: "host", input: { text: "one" } });
  await writeFile(
    paths.messages,
    `${JSON.stringify({
      id: 7,
      room: "recover-room",
      ts: "2026-06-21T00:00:00.000Z",
      from: "host",
      type: "message",
      text: "imported",
      mentions: []
    })}\n`,
    { flag: "a" }
  );

  assert.equal(await recoverNextMessageId(paths.messages), 8);
  const recoveredState = await recoverRoomState(root, "recover-room");
  assert.equal(recoveredState.next_message_id, 8);
  const recovered = await appendMessage({
    root,
    roomId: "recover-room",
    from: "host",
    input: { text: "after restart" }
  });
  assert.equal(recovered.id, 8);
});

test("updateBrief increments version and updates room metadata without a history object", async () => {
  const root = await makeRoot();
  await createRoom({
    root,
    roomId: "brief-room",
    hostAlias: "host",
    now: new Date("2026-06-21T00:00:00.000Z")
  });
  const updated = await updateBrief({
    root,
    roomId: "brief-room",
    body: "New mission context",
    updatedBy: "host",
    now: new Date("2026-06-21T00:01:00.000Z")
  });
  const paths = roomPaths(root, "brief-room");
  const state = JSON.parse(await readFile(paths.state, "utf8")) as {
    brief_version: number;
    brief_updated_at: string;
    brief_updated_by: string;
  };

  assert.equal(updated.brief_version, 2);
  assert.equal(updated.brief_updated_by, "host");
  assert.equal(await readFile(paths.brief, "utf8"), "New mission context");
  assert.equal(state.brief_version, 2);
  assert.equal(state.brief_updated_at, "2026-06-21T00:01:00.000Z");
  assert.equal(state.brief_updated_by, "host");
});

test("brief body size is capped", async () => {
  const root = await makeRoot();
  await createRoom({ root, roomId: "brief-cap-room", hostAlias: "host" });
  await assert.rejects(
    updateBrief({
      root,
      roomId: "brief-cap-room",
      body: "x".repeat(MAX_BRIEF_LENGTH + 1),
      updatedBy: "host"
    }),
    /brief body/
  );
});

test("appendMessage ignores client-supplied server fields", async () => {
  const root = await makeRoot();
  await createRoom({ root, roomId: "whitelist-room", hostAlias: "host" });
  const message = await appendMessage({
    root,
    roomId: "whitelist-room",
    from: "host",
    input: {
      id: 999,
      room: "wrong-room",
      from: "attacker",
      ts: "2000-01-01T00:00:00.000Z",
      type: "system",
      text: "@host hello",
      reply_to: 1,
      client_msg_id: "client-1"
    }
  });

  assert.equal(message.id, 1);
  assert.equal(message.room, "whitelist-room");
  assert.equal(message.from, "host");
  assert.equal(message.type, "message");
  assert.equal(message.reply_to, 1);
  assert.equal(message.client_msg_id, "client-1");
  assert.notEqual(message.ts, "2000-01-01T00:00:00.000Z");
});

test("appendMessage resolves mentions from the stored participant roster", async () => {
  const root = await makeRoot();
  await createRoom({ root, roomId: "mention-room", hostAlias: "host" });
  await writeParticipants(root, "mention-room", [
    {
      alias: "host",
      kind: "human",
      location: "local",
      install: "host",
      attention: "attending",
      joinedAt: "2026-06-21T00:00:00.000Z",
      lastSeenAt: "2026-06-21T00:00:00.000Z"
    },
    {
      alias: "opus",
      kind: "agent",
      location: "local",
      install: "lite",
      attention: "attending",
      joinedAt: "2026-06-21T00:00:00.000Z",
      lastSeenAt: "2026-06-21T00:00:00.000Z"
    }
  ]);

  const message = await appendMessage({
    root,
    roomId: "mention-room",
    from: "host",
    input: { text: "@opus ping @missing" }
  });

  assert.deepEqual(message.mentions, ["opus"]);
});

test("participant cursors are stored separately from message history", async () => {
  const root = await makeRoot();
  await createRoom({ root, roomId: "cursor-room", hostAlias: "host" });
  const paths = roomPaths(root, "cursor-room");

  assert.equal(await readCursor(root, "cursor-room", "host"), 0);
  const cursor = await writeCursor(
    root,
    "cursor-room",
    "host",
    12,
    new Date("2026-06-21T00:02:00.000Z")
  );

  assert.equal(cursor.sinceId, 12);
  assert.equal(await readCursor(root, "cursor-room", "host"), 12);
  assert.equal(await readFile(paths.messages, "utf8"), "");
});
