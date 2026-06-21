import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeSlug, isSafeSlug } from "../src/protocol/index.js";

test("safe slugs accept lowercase room and alias identifiers", () => {
  for (const value of ["room", "room-1", "agent7", "a", "reviewer-2"]) {
    assert.equal(isSafeSlug(value), true, value);
  }
});

test("safe slugs reject traversal, separators, dots, uppercase, and empty values", () => {
  for (const value of ["", ".", "..", "../room", "room/name", "room\\name", "Room", "room_name", "room.name"]) {
    assert.equal(isSafeSlug(value), false, value);
  }
});

test("assertSafeSlug reports the rejected field label", () => {
  assert.throws(() => assertSafeSlug("../room", "room id"), /room id/);
});
