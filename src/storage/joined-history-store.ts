import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { withWriterLock } from "./lock.js";
import { ensureSecureDir, isNotFoundError, writeSecureFile } from "./secure-fs.js";

// Dashboard-owned, device-local snapshot of the history this participant has
// ALREADY received in a joined room (#247). It exists so that a room whose host
// has stopped serving can still be read from the dashboard: the room origin's own
// #211 backup lives in that origin's localStorage, which a dead host can no longer
// serve a page for.
//
// Boundaries this file holds:
//   - device-local only. It lives under AGENTGATHER_HOME; nothing here is uploaded,
//     relayed, or synced, and the host's own log is never read to build it.
//   - NEVER a secret. Text is redacted on the way in (and the platform receiver
//     redacts independently, so a sender that skipped it cannot poison the file).
//   - bounded. Count and byte caps are enforced on every write, oldest dropped
//     first, so a long-lived room cannot grow the file without limit.
//   - atomic + serialized. Writes go through writeSecureFile (temp + rename) under
//     the same writer lock as the rest of a snapshot's read-modify-write.

export interface SnapshotMessage {
  id: number;
  from: string;
  ts: string;
  type: string;
  text: string;
}

export interface SnapshotForumComment {
  id: string;
  author: string;
  ts: string;
  body: string;
}

export interface SnapshotForumPost {
  id: string;
  channel: string;
  title: string;
  author: string;
  ts: string;
  status: string;
  body: string;
  comments: SnapshotForumComment[];
}

export interface JoinedHistorySnapshot {
  roomId: string;
  baseUrl: string;
  /** Highest message id in `messages` — what the offline view honestly claims to hold. */
  cursor: number;
  /** When this device last received history for this room. */
  savedAt: string;
  messages: SnapshotMessage[];
  forumPosts: SnapshotForumPost[];
}

export const SNAPSHOT_MAX_MESSAGES = 250;
export const SNAPSHOT_MAX_FORUM_POSTS = 50;
export const SNAPSHOT_MAX_COMMENTS_PER_POST = 100;
export const SNAPSHOT_MAX_BYTES = 200_000;
// Per-field cap. The byte cap alone cannot hold when a SINGLE entry is enormous
// (trimming keeps at least one message), so each stored string is truncated here.
export const SNAPSHOT_MAX_TEXT_CHARS = 4_000;

export function joinedHistoryDir(home: string): string {
  return path.join(home, "joined-history");
}

// The file name is a hash of the canonical (roomId, baseUrl) pair, never the ids
// themselves: a room id or base URL that contains `/` or `..` therefore cannot
// steer a write outside this directory. Hashing the length-prefixed pair keeps
// ("ab","c") and ("a","bc") distinct.
export function joinedHistoryPath(home: string, key: { roomId: string; baseUrl: string }): string {
  const digest = createHash("sha256")
    .update(`${key.roomId.length}:${key.roomId}\n${key.baseUrl.length}:${key.baseUrl}`)
    .digest("hex");
  return path.join(joinedHistoryDir(home), `${digest}.json`);
}

function joinedHistoryLockPath(home: string, key: { roomId: string; baseUrl: string }): string {
  return `${joinedHistoryPath(home, key)}.lock`;
}

// Exactly the payload writeSecureFile will persist, measured in bytes.
function serializeSnapshot(snapshot: JoinedHistorySnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function serializedBytes(snapshot: JoinedHistorySnapshot): number {
  return Buffer.byteLength(serializeSnapshot(snapshot), "utf8");
}

// Strip anything credential-shaped out of persisted text. Mirrors the room and
// dashboard cache guards (#211) — a bearer token, tgl_ token, `token=` parameter,
// invite/card URL, or bridge capability never reaches disk.
export function redactSnapshotText(value: unknown): string {
  return String(value ?? "")
    .replace(/https?:\/\/(?=\S*(?:token=|snapshot=|tgl_|\/card))\S+/gi, "[redacted-url]")
    .replace(/Bearer\s+\S+/gi, "[redacted-credential]")
    .replace(/[#?&]?(?:token|snapshot)=[^\s&#"']+/gi, "[redacted-token]")
    .replace(/tgl_[A-Za-z0-9_-]+/g, "[redacted-token]")
    .slice(0, SNAPSHOT_MAX_TEXT_CHARS);
}

// What a snapshot read found (#293). Absent and unreadable are different facts and
// must stay different all the way to the screen: a host log can be re-fetched, but
// a snapshot is the ONLY copy of history for a room whose host is gone (#247), so
// "your saved copy is damaged" is the one failure the user can still act on — and
// only while they still can. Reporting it as "nothing saved" spends that window.
//
// This is the single read path rather than a second reader beside the old one:
// a caller that kept the old signature would silently lose the distinction again,
// which is how per-caller drift produced the defect this ticket fixes.
export type JoinedHistoryReadState = "absent" | "ok" | "unreadable";

export interface JoinedHistoryRead {
  state: JoinedHistoryReadState;
  /** The snapshot, only when `state` is "ok". Absent AND unreadable both give null. */
  snapshot: JoinedHistorySnapshot | null;
}

export async function readJoinedHistory(
  home: string,
  key: { roomId: string; baseUrl: string }
): Promise<JoinedHistoryRead> {
  let raw: string;
  try {
    raw = await readFile(joinedHistoryPath(home, key), "utf8");
  } catch (error) {
    // A file that is not there is the ordinary case for a room never opened
    // offline — no warning, exactly as before.
    if (isNotFoundError(error)) return { state: "absent", snapshot: null };
    // Anything else (EACCES, EISDIR, I/O) means a snapshot may well exist and
    // this device cannot read it. That is not absence.
    return { state: "unreadable", snapshot: null };
  }
  let parsed: JoinedHistorySnapshot;
  try {
    parsed = JSON.parse(raw) as JoinedHistorySnapshot;
  } catch {
    // Truncated or hand-edited. Deliberately NOT recovered or partially parsed
    // (#293 out of scope) — and the parse error is discarded rather than
    // returned, because its message can quote the file's own bytes.
    return { state: "unreadable", snapshot: null };
  }
  // A snapshot naming a different room is not this room's history. The file
  // exists and is not what it claims, so it is unreadable-for-this-key rather
  // than absent — flattening it to absence is the same lost signal.
  if (parsed === null || typeof parsed !== "object" || parsed.roomId !== key.roomId || parsed.baseUrl !== key.baseUrl) {
    return { state: "unreadable", snapshot: null };
  }
  return {
    state: "ok",
    snapshot: {
      roomId: parsed.roomId,
      baseUrl: parsed.baseUrl,
      cursor: typeof parsed.cursor === "number" ? parsed.cursor : 0,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      forumPosts: Array.isArray(parsed.forumPosts) ? parsed.forumPosts : []
    }
  };
}

// Merge one batch of ALREADY-RECEIVED history into the snapshot. The caller never
// fetches to fill this — it hands over only what its surface had already loaded.
// Messages de-duplicate by id and forum posts by post id, so a reconnect or a
// re-open cannot double up the transcript.
// `isStillTracked` is re-evaluated INSIDE the writer lock, immediately before the
// write (#247, @re1). Delete changes the joined-room row first and only then removes
// the snapshot under this same lock, so both orderings are safe: a guard that runs
// after the row is gone refuses to write, and a write that already happened is
// removed by the delete waiting on the lock. Without that in-lock re-check, a bridge
// post validated a moment earlier could land a fresh snapshot after deletion
// returned. Returns null when the guard refuses.
export async function recordJoinedHistory(
  home: string,
  entry: {
    roomId: string;
    baseUrl: string;
    messages?: SnapshotMessage[];
    forumPosts?: SnapshotForumPost[];
    savedAt: string;
  },
  isStillTracked?: () => Promise<boolean>
): Promise<JoinedHistorySnapshot | null> {
  const key = { roomId: entry.roomId, baseUrl: entry.baseUrl };
  await ensureSecureDir(joinedHistoryDir(home));
  return withWriterLock(joinedHistoryLockPath(home, key), async () => {
    if (isStillTracked !== undefined && !(await isStillTracked())) return null;
    // The write path's behaviour is deliberately UNCHANGED by #293: an existing
    // file that cannot be read still starts a fresh snapshot rather than blocking
    // the bridge. Recovery is explicitly out of scope, and refusing to write would
    // turn one damaged file into a room that can never save history again.
    const current = (await readJoinedHistory(home, key)).snapshot ?? {
      roomId: entry.roomId,
      baseUrl: entry.baseUrl,
      cursor: 0,
      savedAt: entry.savedAt,
      messages: [],
      forumPosts: []
    };
    const next: JoinedHistorySnapshot = {
      roomId: entry.roomId,
      baseUrl: entry.baseUrl,
      cursor: current.cursor,
      savedAt: entry.savedAt,
      messages: mergeMessages(current.messages, entry.messages ?? []),
      forumPosts: mergeForumPosts(current.forumPosts, entry.forumPosts ?? [])
    };
    next.cursor = next.messages.reduce((highest, message) => Math.max(highest, message.id), 0);
    bound(next);
    await writeSecureFile(joinedHistoryPath(home, key), serializeSnapshot(next));
    return next;
  });
}

// Remove a snapshot when its joined-room row is DELETED (#210). Archive keeps the
// transcript: archive is a reversible hide, and once a host is gone this transcript
// cannot be rebuilt from anywhere, so a reversible action must not destroy it.
//
// Taken under the SAME writer lock as recordJoinedHistory, so it can never
// interleave with a bridge write mid-flight: either the write completes and is then
// removed here, or this removal completes and the write's in-lock guard refuses.
// Returns true when a snapshot was actually removed.
export async function deleteJoinedHistory(
  home: string,
  key: { roomId: string; baseUrl: string }
): Promise<boolean> {
  await ensureSecureDir(joinedHistoryDir(home));
  return withWriterLock(joinedHistoryLockPath(home, key), async () => {
    try {
      await rm(joinedHistoryPath(home, key), { force: false });
      return true;
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  });
}

// EVERY persisted string goes through redactSnapshotText — not just the bodies
// (#247, @re2/@re1). An alias, timestamp, type, channel or status is attacker-
// influenced too: a participant can be named after a card URL, and the dashboard
// renders these fields. Redaction is idempotent, so keying on a redacted id stays
// stable across merges.
function mergeMessages(current: SnapshotMessage[], incoming: SnapshotMessage[]): SnapshotMessage[] {
  const byId = new Map<number, SnapshotMessage>();
  for (const message of [...current, ...incoming]) {
    byId.set(message.id, {
      id: message.id,
      from: redactSnapshotText(message.from),
      ts: redactSnapshotText(message.ts),
      type: redactSnapshotText(message.type ?? "chat"),
      text: redactSnapshotText(message.text)
    });
  }
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

// A re-loaded post replaces its stored copy: the later load is the more complete
// one (a thread open carries the comments a feed row does not).
function mergeForumPosts(current: SnapshotForumPost[], incoming: SnapshotForumPost[]): SnapshotForumPost[] {
  const byId = new Map<string, SnapshotForumPost>();
  for (const post of current) byId.set(post.id, post);
  for (const post of incoming) {
    // Key on the REDACTED id: stored posts already carry redacted ids, so keying on
    // the raw one would file a re-load as a second post instead of merging it.
    const id = redactSnapshotText(post.id);
    const existing = byId.get(id);
    const comments = post.comments.length > 0 ? post.comments : (existing?.comments ?? []);
    byId.set(id, {
      id,
      channel: redactSnapshotText(post.channel),
      title: redactSnapshotText(post.title),
      author: redactSnapshotText(post.author),
      ts: redactSnapshotText(post.ts),
      status: redactSnapshotText(post.status),
      body: redactSnapshotText(post.body),
      comments: comments.slice(-SNAPSHOT_MAX_COMMENTS_PER_POST).map((comment) => ({
        id: redactSnapshotText(comment.id),
        author: redactSnapshotText(comment.author),
        ts: redactSnapshotText(comment.ts),
        body: redactSnapshotText(comment.body)
      }))
    });
  }
  return [...byId.values()];
}

// Enforce the retention caps in place: oldest messages and oldest forum posts go
// first, then the byte cap trims further until the serialized snapshot fits. The
// cursor is recomputed from what actually survives, so the offline view never
// claims to hold a message that was dropped.
function bound(snapshot: JoinedHistorySnapshot): void {
  if (snapshot.messages.length > SNAPSHOT_MAX_MESSAGES) {
    snapshot.messages = snapshot.messages.slice(snapshot.messages.length - SNAPSHOT_MAX_MESSAGES);
  }
  if (snapshot.forumPosts.length > SNAPSHOT_MAX_FORUM_POSTS) {
    snapshot.forumPosts = snapshot.forumPosts.slice(snapshot.forumPosts.length - SNAPSHOT_MAX_FORUM_POSTS);
  }
  // Measure what is actually written — the pretty-printed payload, in BYTES (#247,
  // @re2). Counting compact-JSON characters would have let the real file run several
  // times past the named cap for indentation and multi-byte content.
  while (
    serializedBytes(snapshot) > SNAPSHOT_MAX_BYTES &&
    (snapshot.messages.length > 1 || snapshot.forumPosts.length > 0)
  ) {
    if (snapshot.forumPosts.length > 0) snapshot.forumPosts = snapshot.forumPosts.slice(1);
    else snapshot.messages = snapshot.messages.slice(1);
  }
  snapshot.cursor = snapshot.messages.reduce((highest, message) => Math.max(highest, message.id), 0);
}
