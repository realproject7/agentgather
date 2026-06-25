import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANNEL_LIFECYCLES,
  CHANNEL_TYPES,
  DEFAULT_CHANNEL_ID,
  HISTORY_SOURCES,
  PARTICIPANT_ROLES,
  assertValidBoardroom,
  assertValidChannel,
  deriveDefaultBoardroom,
  participantIdentity,
  roleFromKind,
  type Boardroom,
  type Channel
} from "../src/protocol/index.js";
import type { Participant } from "../src/protocol/index.js";

const participant = (overrides: Partial<Participant> = {}): Participant => ({
  alias: "reviewer",
  kind: "agent",
  location: "local",
  install: "lite",
  attention: "manual",
  is_host: false,
  joinedAt: "2026-06-21T00:00:00.000Z",
  lastSeenAt: "2026-06-21T00:00:00.000Z",
  ...overrides
});

test("lifecycle / channel-type / history-source / role vocab is present in the model", () => {
  assert.deepEqual([...CHANNEL_TYPES], ["chat", "forum"]);
  assert.deepEqual([...CHANNEL_LIFECYCLES], ["active", "idle", "inactive", "removed"]);
  assert.deepEqual([...HISTORY_SOURCES], ["live-host", "local-cache", "exported-summary", "offline-empty"]);
  assert.deepEqual([...PARTICIPANT_ROLES], ["human", "agent"]);
});

test("roleFromKind models humans and agents separately (system collapses to agent)", () => {
  assert.equal(roleFromKind("human"), "human");
  assert.equal(roleFromKind("agent"), "agent");
  assert.equal(roleFromKind("system"), "agent");
});

test("participantIdentity carries stable id, role, and a hashed reconnect marker — never a raw token", () => {
  const id = participantIdentity(
    participant({ alias: "host", kind: "human", is_host: true, display_name: "Host", token_hash: "a".repeat(64) })
  );
  assert.equal(id.participantId, "host");
  assert.equal(id.displayName, "Host");
  assert.equal(id.role, "human");
  assert.equal(id.isHost, true);
  assert.equal(id.reconnectable, true);
  assert.equal(id.nameOwnerHash, "a".repeat(64));

  // No participant carries a raw token field, and the identity exposes only the hash.
  const serialized = JSON.stringify(id);
  assert.equal(serialized.includes("token"), false, "identity must not expose a raw token");

  // A participant with no token hash is not reconnectable and exposes no marker.
  const anon = participantIdentity(participant({ alias: "guest" }));
  assert.equal(anon.displayName, "guest");
  assert.equal(anon.reconnectable, false);
  assert.equal(anon.nameOwnerHash, undefined);
});

test("deriveDefaultBoardroom projects a legacy bare room to one #general chat channel", () => {
  const boardroom = deriveDefaultBoardroom({
    id: "legacy-room",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z"
  });
  assert.equal(boardroom.id, "legacy-room");
  assert.equal(boardroom.legacy, true);
  assert.equal(boardroom.lifecycle, "active");
  assert.equal(boardroom.channels.length, 1);
  const [channel] = boardroom.channels;
  assert.equal(channel?.id, DEFAULT_CHANNEL_ID);
  assert.equal(channel?.type, "chat");
  assert.equal(channel?.lifecycle, "active");
});

test("a boardroom can model multiple channels of chat and forum types", () => {
  const boardroom: Boardroom = {
    id: "br",
    channels: [
      { id: "general", name: "general", type: "chat", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" },
      { id: "rfcs", name: "rfcs", type: "forum", lifecycle: "idle", createdAt: "2026-06-21T00:00:00.000Z" }
    ],
    lifecycle: "active",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    legacy: false
  };
  assert.doesNotThrow(() => assertValidBoardroom(boardroom));
});

test("model validation rejects bad channel types, lifecycles, and duplicate/empty channels", () => {
  const base: Channel = { id: "x", name: "x", type: "chat", lifecycle: "active", createdAt: "t" };
  assert.throws(() => assertValidChannel({ ...base, type: "video" as unknown as Channel["type"] }));
  assert.throws(() => assertValidChannel({ ...base, lifecycle: "paused" as unknown as Channel["lifecycle"] }));
  assert.throws(() => assertValidChannel({ ...base, id: "Bad Id" }));
  const empty: Boardroom = { id: "br", channels: [], lifecycle: "active", createdAt: "t", updatedAt: "t", legacy: false };
  assert.throws(() => assertValidBoardroom(empty), /at least one channel/);
  const dup: Boardroom = { ...empty, channels: [base, { ...base, name: "y" }] };
  assert.throws(() => assertValidBoardroom(dup), /duplicate channel id/);
});
