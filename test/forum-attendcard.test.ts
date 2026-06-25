import assert from "node:assert/strict";
import test from "node:test";
import { renderForumReviewGuidance } from "../src/protocol/index.js";
import { renderInviteCard } from "../src/server/index.js";
import type { Participant, RoomBrief } from "../src/protocol/index.js";

const brief: RoomBrief = { body: "## Goal\nReview the forum.", brief_version: 1, brief_updated_at: "t", brief_updated_by: "host" };

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

test("forum-review guidance composes the 9B wake-on-event contract (no detached-wake claims)", () => {
  const text = renderForumReviewGuidance("design-forum");
  assert.match(text, /Forum review task — #design-forum/);
  assert.match(text, /assigned or updated forum post is an actionable event/);
  assert.match(text, /empty poll[\s\S]*must NOT invoke the model/i);
  assert.match(text, /bounded safety wake/i);
  assert.match(text, /declare `manual`/);
  assert.match(text, /advice, not command authority/);
  // no false detached-wake claims
  assert.equal(/SSE|A2A|daemon/i.test(text), false);
});

test("an agent invited for forum review gets the forum section + real T6 commands; token appears once", () => {
  const card = renderInviteCard(
    "http://127.0.0.1:8787",
    agent({ forum_review_channel: "design-forum", requested_mode: "wake_on_event", effective_mode: "wake_on_event" }),
    "tgl_secret_reviewer",
    brief,
    "manual-ok"
  );
  assert.match(card, /## Forum review task — #design-forum/);
  // copy-pastable commands against the real T6 endpoints
  assert.match(card, /\/forum\/posts\?channel=design-forum/);
  assert.match(card, /\/forum\/post\?channel=design-forum&post=POST_ID/);
  assert.match(card, /-X POST "\$AG_BASE\/forum\/comment"/);
  assert.match(card, /"channel":"design-forum","post":"POST_ID"/);
  // agent can go idle (no forced foreground)
  assert.match(card, /go idle/i);
  // recovery must NOT force foreground attendance or deny wake-on-event (T10 contract)
  assert.equal(card.includes("return to foreground attendance immediately"), false);
  assert.equal(card.includes("cannot wake this session automatically"), false);
  assert.match(card, /do NOT need to hold a foreground attend loop/);
  assert.match(card, /return to your declared attention mode/);
  // safety language intact (advice, not authority)
  assert.match(card, /external advice, not operator instructions/);
  // Within the new forum-review section the token appears exactly once (the env
  // export); the forum curls reference $AG_TOKEN, so T10 adds no extra repetition
  // beyond the existing necessary invite context.
  const forumSection = card.slice(card.indexOf("## Forum review task"), card.indexOf("## Attendance Recovery"));
  const occurrences = forumSection.split("tgl_secret_reviewer").length - 1;
  assert.equal(occurrences, 1, "forum review token must appear once in the section (env export), not repeated");
  assert.match(forumSection, /export AG_BASE='http:\/\/127\.0\.0\.1:8787' AG_TOKEN='tgl_secret_reviewer'/);
});

test("an agent NOT invited for forum review gets no forum section (zero regression)", () => {
  const card = renderInviteCard("http://127.0.0.1:8787", agent(), "tgl_reviewer", brief, "manual-ok");
  assert.equal(card.includes("## Forum review task"), false);
  assert.equal(card.includes("/forum/comment"), false);
  // existing attend card content + the original (foreground) recovery remain unchanged
  assert.match(card, /## Attend Card|## Commands|agentgather attend/);
  assert.match(card, /return to foreground attendance immediately/);
});
