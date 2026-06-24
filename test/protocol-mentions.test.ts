import assert from "node:assert/strict";
import test from "node:test";
import { analyzeMentions, parseMentions } from "../src/protocol/index.js";

const roster = ["codex", "opus", "reviewer-1"];

test("parseMentions resolves known aliases in first-seen order", () => {
  assert.deepEqual(parseMentions("@opus please ask @codex and @opus again", roster), [
    "opus",
    "codex"
  ]);
});

test("parseMentions ignores unknown aliases", () => {
  assert.deepEqual(parseMentions("@opus @unknown @reviewer-1", roster), [
    "opus",
    "reviewer-1"
  ]);
});

test("parseMentions ignores inline code spans", () => {
  assert.deepEqual(parseMentions("Ping @opus but not `@codex`", roster), ["opus"]);
});

test("parseMentions ignores fenced code blocks", () => {
  const text = [
    "@opus check this:",
    "```",
    "@codex should not resolve here",
    "```",
    "and @reviewer-1 outside"
  ].join("\n");
  assert.deepEqual(parseMentions(text, roster), ["opus", "reviewer-1"]);
});

test("analyzeMentions separates resolved aliases from unknown @-tokens", () => {
  const result = analyzeMentions("@opus thanks, also @seb and @opus again plus @ghost", roster);
  assert.deepEqual(result.mentions, ["opus"]);
  assert.deepEqual(result.unknown, ["seb", "ghost"]);
});

test("analyzeMentions does not warn on @-tokens inside code spans", () => {
  const text = ["talk to @opus", "`@seb`", "```", "@ghost", "```"].join("\n");
  const result = analyzeMentions(text, roster);
  assert.deepEqual(result.mentions, ["opus"]);
  assert.deepEqual(result.unknown, []);
});

test("analyzeMentions deduplicates both lists in first-seen order", () => {
  const result = analyzeMentions("@ghost @opus @ghost @codex @opus", roster);
  assert.deepEqual(result.mentions, ["opus", "codex"]);
  assert.deepEqual(result.unknown, ["ghost"]);
});
