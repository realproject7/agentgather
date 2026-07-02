import assert from "node:assert/strict";
import test from "node:test";
import type { AttentionMode } from "../src/protocol/index.js";
import { describeWakeTier, wakeTierForMode } from "../src/protocol/index.js";

test("wake tier is derived from mode: A=wake_on_event, C=manual, B=everything between (#185)", () => {
  const expected: Record<AttentionMode, "A" | "B" | "C"> = {
    wake_on_event: "A",
    foreground_attended: "B",
    heartbeat: "B",
    manual: "C"
  };
  for (const [mode, tier] of Object.entries(expected) as [AttentionMode, "A" | "B" | "C"][]) {
    assert.equal(wakeTierForMode(mode), tier, `${mode} → Tier ${tier}`);
  }
});

test("the most-capable foreground mode is Tier B, not A — kills the online-dot lie (#185)", () => {
  // foreground_attended looks "most online" but has no event-driven wake, so it
  // must NOT read as auto-wake (Tier A). Only wake_on_event earns Tier A.
  assert.equal(wakeTierForMode("foreground_attended"), "B");
  assert.notEqual(wakeTierForMode("foreground_attended"), wakeTierForMode("wake_on_event"));
});

test("tier copy is behavior-defined and honest (auto-wake / notify / relay) (#185)", () => {
  const a = describeWakeTier("A");
  const b = describeWakeTier("B");
  const c = describeWakeTier("C");
  assert.equal(a.tier, "A");
  assert.match(a.label, /Tier A/);
  assert.match(a.headline, /wakes on|auto/i);
  assert.match(b.label, /Tier B/);
  assert.match(b.headline, /notif|nudge|no event-driven wake/i);
  assert.match(c.label, /Tier C/);
  assert.match(c.headline, /relay|manual/i);
  // No harness-specific promises (matches the vendor-neutral 9B mapping).
  for (const copy of [a, b, c]) {
    for (const harness of ["Claude", "Codex", "Gemini", "daemon", "cron", "supervisor"]) {
      assert.equal(copy.headline.includes(harness), false, `tier copy must not name ${harness}`);
    }
  }
});
