import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendServerMessage, createBoardroom, createRoom, writeParticipants } from "../src/storage/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
import type { Participant } from "../src/protocol/index.js";

const mkP = (alias: string, kind: Participant["kind"], token: string, host = false): Participant => ({
  alias,
  kind,
  location: "local",
  install: "lite",
  attention: "manual",
  is_host: host,
  token_hash: participantTokenHash(token),
  joinedAt: "2026-06-21T00:00:00.000Z",
  lastSeenAt: "2026-06-21T00:00:00.000Z"
});

const TOKEN = "tgl_agent";
const HOST_TOKEN = "tgl_host_secret";

// A boardroom room with #general (chat) + #review-forum (forum).
async function startBoardroom(): Promise<{ baseUrl: string; token: string; close: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-boardhttp-"));
  await createRoom({ root, roomId: "demo", hostAlias: "host" });
  await writeParticipants(root, "demo", [mkP("host", "human", HOST_TOKEN, true), mkP("reviewer", "agent", TOKEN)]);
  await createBoardroom(root, "demo", {
    name: "Demo Boardroom",
    channels: [
      { id: "general", name: "general", type: "chat", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" },
      { id: "review-forum", name: "review-forum", type: "forum", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" }
    ]
  });
  // A secret-bearing message body must never leak through the metadata surface.
  await appendServerMessage({ root, roomId: "demo", from: "host", text: "SUPER_SECRET_MESSAGE_BODY" });
  const server = createRoomHttpServer({ root, roomId: "demo", baseUrl: "http://127.0.0.1:0", rateLimitPerMinute: 1000 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, token: TOKEN, close: () => new Promise((r) => server.close(() => r())) };
}

// A legacy bare room: createRoom only, no boardroom.json — must project to #general.
async function startLegacy(): Promise<{ baseUrl: string; token: string; close: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-boardhttp-legacy-"));
  await createRoom({ root, roomId: "demo", hostAlias: "host" });
  await writeParticipants(root, "demo", [mkP("host", "human", HOST_TOKEN, true), mkP("reviewer", "agent", TOKEN)]);
  const server = createRoomHttpServer({ root, roomId: "demo", baseUrl: "http://127.0.0.1:0", rateLimitPerMinute: 1000 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, token: TOKEN, close: () => new Promise((r) => server.close(() => r())) };
}

const authed = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}` } });

type ChannelMeta = { id: string; name: string; type: string; lifecycle: string };
type BoardroomMeta = { id: string; name?: string; lifecycle: string; legacy: boolean; channels: ChannelMeta[] };

test("GET /boardroom requires auth", async () => {
  const fx = await startBoardroom();
  try {
    assert.equal((await fetch(`${fx.baseUrl}/boardroom`)).status, 401);
    assert.equal((await fetch(`${fx.baseUrl}/boardroom`, authed("wrong"))).status, 403);
  } finally {
    await fx.close();
  }
});

test("GET /boardroom exposes boardroom + channel metadata (id/name/type/lifecycle)", async () => {
  const fx = await startBoardroom();
  try {
    const res = await fetch(`${fx.baseUrl}/boardroom`, authed(fx.token));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; boardroom: BoardroomMeta };
    assert.equal(body.ok, true);
    assert.equal(body.boardroom.id, "demo");
    assert.equal(body.boardroom.name, "Demo Boardroom");
    assert.equal(body.boardroom.legacy, false);
    assert.deepEqual(
      body.boardroom.channels.map((c) => ({ id: c.id, type: c.type })),
      [
        { id: "general", type: "chat" },
        { id: "review-forum", type: "forum" }
      ]
    );
    for (const channel of body.boardroom.channels) {
      assert.equal(typeof channel.name, "string");
      assert.equal(channel.lifecycle, "active");
    }
  } finally {
    await fx.close();
  }
});

test("GET /boardroom projects a legacy bare room to a single #general chat channel", async () => {
  const fx = await startLegacy();
  try {
    const res = await fetch(`${fx.baseUrl}/boardroom`, authed(fx.token));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { boardroom: BoardroomMeta };
    assert.equal(body.boardroom.legacy, true);
    assert.equal(body.boardroom.channels.length, 1);
    assert.equal(body.boardroom.channels[0]?.id, "general");
    assert.equal(body.boardroom.channels[0]?.type, "chat");
  } finally {
    await fx.close();
  }
});

test("GET /boardroom leaks no tokens, invite URLs, or message bodies", async () => {
  const fx = await startBoardroom();
  try {
    const raw = await (await fetch(`${fx.baseUrl}/boardroom`, authed(fx.token))).text();
    assert.ok(!raw.includes("token_hash"), "must not expose token_hash");
    assert.ok(!raw.includes(TOKEN), "must not expose the raw participant token");
    assert.ok(!raw.includes(HOST_TOKEN), "must not expose the host token");
    assert.ok(!/invite/i.test(raw), "must not expose invite URLs");
    assert.ok(!raw.includes("SUPER_SECRET_MESSAGE_BODY"), "must not expose message bodies");
  } finally {
    await fx.close();
  }
});

test("GET /status gains a metadata-only boardroom field without dropping existing keys", async () => {
  const fx = await startBoardroom();
  try {
    const res = await fetch(`${fx.baseUrl}/status`, authed(fx.token));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { room: string; room_status: string; participants: unknown[]; boardroom: BoardroomMeta };
    // Existing shape preserved (zero regression).
    assert.equal(body.room, "demo");
    assert.equal(body.room_status, "open");
    assert.ok(Array.isArray(body.participants));
    // New, additive boardroom metadata.
    assert.equal(body.boardroom.id, "demo");
    assert.equal(body.boardroom.channels.length, 2);
    // Same privacy gate on the /status payload.
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes("token_hash") && !raw.includes(TOKEN) && !raw.includes(HOST_TOKEN));
  } finally {
    await fx.close();
  }
});
