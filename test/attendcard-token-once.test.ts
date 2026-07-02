import assert from "node:assert/strict";
import test from "node:test";
import { renderInviteCard } from "../src/server/index.js";
import type { Participant, RoomBrief } from "../src/protocol/index.js";

// #109: agent attend cards must emit the raw participant token exactly once (via
// the AG_TOKEN env export) and reference $AG_TOKEN in every curl example, instead
// of repeating the raw token across 5+ commands where it is easy to leak.

const brief: RoomBrief = { body: "## Goal\nReview.", brief_version: 1, brief_updated_at: "t", brief_updated_by: "host" };

const agent = (extra: Partial<Participant> = {}): Participant => ({
  alias: "reviewer",
  kind: "agent",
  location: "local",
  install: "lite",
  attention: "manual",
  is_host: false,
  joinedAt: "t",
  lastSeenAt: "t",
  ...extra
});

const TOKEN = "tgl_secret_reviewer";
const countToken = (s: string): number => s.split(TOKEN).length - 1;

test("agent attend card emits the raw token exactly once via the AG_TOKEN export; every curl uses $AG_TOKEN (#109)", () => {
  const card = renderInviteCard("http://127.0.0.1:8787", agent(), TOKEN, brief, "manual-ok");
  assert.equal(countToken(card), 1, "raw token must appear exactly once in the card");
  // Emitted once, in the env export.
  assert.match(card, /export AG_BASE='http:\/\/127\.0\.0\.1:8787' AG_TOKEN='tgl_secret_reviewer'/);
  assert.equal(card.split("AG_TOKEN='").length - 1, 1, "AG_TOKEN must be exported exactly once");
  // Every authenticated example references the env var, not the raw token.
  assert.match(card, /curl -s "\$AG_BASE\/card\?participant=reviewer&token=\$AG_TOKEN"/);
  assert.match(card, /curl -s -X POST "\$AG_BASE\/join" -H "Authorization: Bearer \$AG_TOKEN"/);
  assert.match(card, /curl -s "\$AG_BASE\/wait\?participant=reviewer&since_id=0" -H "Authorization: Bearer \$AG_TOKEN"/);
  assert.match(card, /curl -s "\$AG_BASE\/messages\?since_id=0" -H "Authorization: Bearer \$AG_TOKEN"/);
  assert.match(card, /curl -s -X POST "\$AG_BASE\/messages" -H "Authorization: Bearer \$AG_TOKEN"/);
  assert.match(card, /agentgather attend --json/);
  // No curl embeds the raw bearer token.
  assert.equal(card.includes(`Bearer ${TOKEN}`), false, "no example may embed the raw bearer token");
});

test("agent attend card WITH a forum-review task still emits the token exactly once (single export) (#109)", () => {
  const card = renderInviteCard(
    "http://127.0.0.1:8787",
    agent({ forum_review_channel: "design-forum", requested_mode: "wake_on_event", effective_mode: "wake_on_event" }),
    TOKEN,
    brief,
    "manual-ok"
  );
  assert.equal(countToken(card), 1, "raw token must appear exactly once across commands + forum section");
  assert.equal(card.split("AG_TOKEN='").length - 1, 1, "AG_TOKEN must be exported exactly once for a forum-review card");
  assert.match(card, /Forum commands \(reuse the AG_BASE \/ AG_TOKEN exported above\)/);
  assert.equal(card.includes(`Bearer ${TOKEN}`), false, "forum curls must not embed the raw bearer token");
});

test("human invite card carries the token once (browser link) with no curl repetition (#109)", () => {
  const card = renderInviteCard("http://127.0.0.1:8787", agent({ kind: "human", alias: "sam" }), TOKEN, brief);
  assert.equal(countToken(card), 1, "human invite token appears once in the browser link");
  assert.doesNotMatch(card, /curl -s/);
  assert.match(card, /#token=tgl_secret_reviewer/);
});
