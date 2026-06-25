import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoardroom, createForumPost, createRoom, writeParticipants } from "../src/storage/index.js";
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

async function startFixture(): Promise<{ baseUrl: string; token: string; close: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-forumhttp-"));
  const token = "tgl_agent";
  await createRoom({ root, roomId: "demo", hostAlias: "host" });
  await writeParticipants(root, "demo", [mkP("host", "human", "tgl_host", true), mkP("reviewer", "agent", token)]);
  await createBoardroom(root, "demo", {
    channels: [
      { id: "general", name: "general", type: "chat", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" },
      { id: "design-forum", name: "design-forum", type: "forum", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" }
    ]
  });
  await createForumPost(root, "demo", "design-forum", { id: "rfc-1", author: "host", title: "Adopt the kit", body: "## Proposal\nUse it.", tags: ["design"] });
  const server = createRoomHttpServer({ root, roomId: "demo", baseUrl: "http://127.0.0.1:0", rateLimitPerMinute: 1000 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, token, close: () => new Promise((r) => server.close(() => r())) };
}

const authed = (token: string, body?: unknown): RequestInit => ({
  method: body === undefined ? "GET" : "POST",
  headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

test("GET /forum/posts requires auth and returns posts with a derived comment_count", async () => {
  const fx = await startFixture();
  try {
    assert.equal((await fetch(`${fx.baseUrl}/forum/posts?channel=design-forum`)).status, 401);
    const res = await fetch(`${fx.baseUrl}/forum/posts?channel=design-forum`, authed(fx.token));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { posts: Array<{ id: string; comment_count: number }> };
    assert.equal(body.posts.length, 1);
    assert.equal(body.posts[0]?.id, "rfc-1");
    assert.equal(body.posts[0]?.comment_count, 0);
  } finally {
    await fx.close();
  }
});

test("GET /forum/post returns the post + comments; POST /forum/comment appends (authored by caller)", async () => {
  const fx = await startFixture();
  try {
    const post = await fetch(`${fx.baseUrl}/forum/post?channel=design-forum&post=rfc-1`, authed(fx.token));
    const thread = (await post.json()) as { post: { title: string }; comments: unknown[] };
    assert.equal(thread.post.title, "Adopt the kit");
    assert.equal(thread.comments.length, 0);

    const add = await fetch(`${fx.baseUrl}/forum/comment`, authed(fx.token, { channel: "design-forum", post: "rfc-1", body: "looks good" }));
    assert.equal(add.status, 201);
    const created = (await add.json()) as { comment: { id: string; author: string; body: string } };
    assert.equal(created.comment.id, "c1");
    assert.equal(created.comment.author, "reviewer"); // authored by the caller, not client-supplied

    const after = await fetch(`${fx.baseUrl}/forum/post?channel=design-forum&post=rfc-1`, authed(fx.token));
    assert.equal(((await after.json()) as { comments: unknown[] }).comments.length, 1);
  } finally {
    await fx.close();
  }
});

test("POST /forum/posts creates a post authored by the caller", async () => {
  const fx = await startFixture();
  try {
    const res = await fetch(`${fx.baseUrl}/forum/posts`, authed(fx.token, { channel: "design-forum", title: "New thread", body: "body", tags: ["q"] }));
    assert.equal(res.status, 201);
    const created = (await res.json()) as { post: { author: string; status: string } };
    assert.equal(created.post.author, "reviewer");
    assert.equal(created.post.status, "open");
  } finally {
    await fx.close();
  }
});

test("forum endpoints reject a non-forum channel and a missing post", async () => {
  const fx = await startFixture();
  try {
    // A chat channel is rejected on every forum path (not treated as an empty forum).
    assert.equal((await fetch(`${fx.baseUrl}/forum/posts?channel=general`, authed(fx.token))).status, 400);
    const create = await fetch(`${fx.baseUrl}/forum/posts`, authed(fx.token, { channel: "general", title: "x", body: "y" }));
    assert.equal(create.status, 400); // general is a chat channel, not a forum
    const missing = await fetch(`${fx.baseUrl}/forum/post?channel=design-forum&post=nope`, authed(fx.token));
    assert.equal(missing.status, 404);
    // commenting on a non-forum channel is rejected on the append path too
    const comment = await fetch(`${fx.baseUrl}/forum/comment`, authed(fx.token, { channel: "general", post: "rfc-1", body: "nope" }));
    assert.equal(comment.status, 400);
  } finally {
    await fx.close();
  }
});
