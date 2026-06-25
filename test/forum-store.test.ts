import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addForumComment,
  createBoardroom,
  createForumPost,
  createRoom,
  listForumPosts,
  readForumPost,
  roomPaths,
  setForumPostStatus
} from "../src/storage/index.js";
import {
  DEFAULT_FORUM_POST_STATUS,
  FORUM_POST_STATUSES,
  FORUM_SCHEMA_VERSION,
  MAX_FORUM_TAGS,
  assertValidForumPost,
  normalizeForumTags,
  parseForumStatus,
  type ForumPost
} from "../src/protocol/index.js";

async function seedForum(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-t6-"));
  await createRoom({ root, roomId: "demo", hostAlias: "host" });
  await createBoardroom(root, "demo", {
    channels: [
      { id: "general", name: "general", type: "chat", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" },
      { id: "design-forum", name: "design-forum", type: "forum", lifecycle: "active", createdAt: "2026-06-21T00:00:00.000Z" }
    ]
  });
  return root;
}

test("forum contract: frozen status vocabulary + tag normalization", () => {
  assert.deepEqual([...FORUM_POST_STATUSES], ["open", "answered", "resolved", "closed"]);
  assert.equal(DEFAULT_FORUM_POST_STATUS, "open");
  assert.equal(parseForumStatus("resolved"), "resolved");
  assert.throws(() => parseForumStatus("wontfix"));
  // tags: trim, lowercase, dedupe (order-preserving), slug-validated, capped.
  assert.deepEqual(normalizeForumTags([" Bug ", "bug", "Perf"]), ["bug", "perf"]);
  assert.throws(() => normalizeForumTags(["not a slug"]));
  assert.throws(() => normalizeForumTags(Array.from({ length: MAX_FORUM_TAGS + 1 }, (_, i) => `t${i}`)));
});

test("create/read a forum post on a forum channel (host-owned, 0600, frozen shape)", async () => {
  const root = await seedForum();
  const post = await createForumPost(
    root,
    "demo",
    "design-forum",
    { id: "rfc-1", author: "host", title: "Adopt the kit", body: "# Proposal\n\nUse the kit.", tags: ["design", "rfc"] },
    new Date("2026-06-21T00:00:00.000Z")
  );
  assert.equal(post.schema_version, FORUM_SCHEMA_VERSION);
  assert.equal(post.status, "open");
  assert.deepEqual(post.tags, ["design", "rfc"]);
  assert.doesNotThrow(() => assertValidForumPost(post));

  const { post: read, comments } = await readForumPost(root, "demo", "design-forum", "rfc-1");
  assert.equal(read.title, "Adopt the kit");
  assert.equal(read.body, "# Proposal\n\nUse the kit.");
  assert.equal(comments.length, 0);

  // Host-owned file at 0600 under the room dir; Markdown body stored raw.
  const file = path.join(roomPaths(root, "demo").room, "forum", "design-forum", "rfc-1", "post.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("creating a post on a non-forum channel is rejected", async () => {
  const root = await seedForum();
  await assert.rejects(
    createForumPost(root, "demo", "general", { author: "host", title: "x", body: "y" }),
    /not a forum channel/
  );
});

test("adding a comment on a non-forum channel is rejected (boundary on the append path)", async () => {
  const root = await seedForum();
  await assert.rejects(
    addForumComment(root, "demo", "general", "rfc-1", { author: "host", body: "nope" }),
    /not a forum channel/
  );
});

test("comments are append-only and sequentially numbered", async () => {
  const root = await seedForum();
  await createForumPost(root, "demo", "design-forum", { id: "p1", author: "host", title: "T", body: "B" });
  const c1 = await addForumComment(root, "demo", "design-forum", "p1", { author: "reviewer", body: "first" });
  const c2 = await addForumComment(root, "demo", "design-forum", "p1", { author: "host", body: "second" });
  assert.equal(c1.id, "c1");
  assert.equal(c2.id, "c2");
  const { comments } = await readForumPost(root, "demo", "design-forum", "p1");
  assert.deepEqual(comments.map((c) => [c.id, c.author, c.body]), [["c1", "reviewer", "first"], ["c2", "host", "second"]]);
});

test("status + tags round-trip; status transitions update the post", async () => {
  const root = await seedForum();
  await createForumPost(root, "demo", "design-forum", { id: "p2", author: "host", title: "Q", body: "?", status: "open" });
  const answered = await setForumPostStatus(root, "demo", "design-forum", "p2", "answered");
  assert.equal(answered.status, "answered");
  const resolved = await setForumPostStatus(root, "demo", "design-forum", "p2", "resolved");
  assert.equal(resolved.status, "resolved");
  const { post } = await readForumPost(root, "demo", "design-forum", "p2");
  assert.equal(post.status, "resolved");
});

test("listForumPosts returns posts sorted by creation; duplicate ids rejected", async () => {
  const root = await seedForum();
  await createForumPost(root, "demo", "design-forum", { id: "a", author: "host", title: "A", body: "" }, new Date("2026-06-21T00:00:00.000Z"));
  await createForumPost(root, "demo", "design-forum", { id: "b", author: "host", title: "B", body: "" }, new Date("2026-06-22T00:00:00.000Z"));
  const posts = await listForumPosts(root, "demo", "design-forum");
  assert.deepEqual(posts.map((p: ForumPost) => p.id), ["a", "b"]);
  await assert.rejects(createForumPost(root, "demo", "design-forum", { id: "a", author: "host", title: "dup", body: "" }));
});

test("no forum dir yet → listForumPosts is empty (no duplicated/eager storage)", async () => {
  const root = await seedForum();
  assert.deepEqual(await listForumPosts(root, "demo", "design-forum"), []);
});

test("the frozen schema_version is enforced by the validators", () => {
  const base: ForumPost = {
    schema_version: FORUM_SCHEMA_VERSION,
    id: "p",
    channel_id: "design-forum",
    author: "host",
    title: "T",
    body: "B",
    status: "open",
    tags: [],
    created_at: "t",
    updated_at: "t"
  };
  assert.doesNotThrow(() => assertValidForumPost(base));
  assert.throws(() => assertValidForumPost({ ...base, schema_version: 999 }), /schema_version/);
  assert.throws(() => assertValidForumPost({ ...base, schema_version: undefined as unknown as number }), /schema_version/);
});

test("a post.json with a wrong schema_version is rejected on read (not silently accepted)", async () => {
  const root = await seedForum();
  const dir = path.join(roomPaths(root, "demo").room, "forum", "design-forum", "future");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "post.json"),
    JSON.stringify({ schema_version: 2, id: "future", channel_id: "design-forum", author: "host", title: "T", body: "B", status: "open", tags: [], created_at: "t", updated_at: "t" })
  );
  await assert.rejects(readForumPost(root, "demo", "design-forum", "future"), /schema_version/);
  // listForumPosts skips/raises rather than silently returning the bad record.
  await assert.rejects(listForumPosts(root, "demo", "design-forum"), /schema_version/);
});
