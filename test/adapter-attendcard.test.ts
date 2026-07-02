import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIONABLE_EVENTS,
  HARNESS_ADAPTERS,
  renderAgentInstructions,
  renderAttentionGuidance,
  renderHarnessMappingTable,
  type WakeAdapter
} from "../src/protocol/index.js";
import { renderInviteCard } from "../src/server/index.js";
import type { Participant, RoomBrief } from "../src/protocol/index.js";

test("actionable events cover mention / assigned post / relevant message / session change", () => {
  assert.deepEqual([...ACTIONABLE_EVENTS], ["mention", "assigned_post", "relevant_message", "session_state_change"]);
});

test("the adapter is defined purely by behavior (no prescribed mechanism)", () => {
  // A trivial in-memory adapter satisfies the interface — proves it's behavioral.
  let woke = 0;
  const handlers: Array<(e: (typeof ACTIONABLE_EVENTS)[number]) => void> = [];
  const adapter: WakeAdapter = {
    pollCadence: () => 30,
    onEvent: (h) => handlers.push(h),
    wake: () => {
      woke += 1;
    },
    idle: () => {},
    supportsBackgroundWake: () => true
  };
  adapter.onEvent(() => adapter.wake());
  handlers[0]?.("mention"); // an actionable event invokes the model
  assert.equal(woke, 1);
  assert.equal(adapter.pollCadence(), 30);
});

test("harness mapping is vendor-neutral and every harness can fall back to manual", () => {
  const harnesses = HARNESS_ADAPTERS.map((h) => h.harness);
  for (const expected of ["Claude", "Codex", "Gemini", "OpenClaw", "Hermes", "Generic"]) {
    assert.ok(harnesses.some((h) => h.includes(expected)), `harness table must mention ${expected}`);
  }
  // Honest manual fallback: a no-background harness declares manual; conditional
  // harnesses keep manual available.
  const generic = HARNESS_ADAPTERS.find((h) => h.harness.startsWith("Generic"));
  assert.deepEqual(generic?.declares, ["manual"]);
  for (const h of HARNESS_ADAPTERS) assert.ok(h.declares.includes("manual"), `${h.harness} must keep manual as a fallback`);
  // No Claude-specific assumption baked into the table shape: non-Claude rows exist with their own notes.
  assert.ok(HARNESS_ADAPTERS.some((h) => h.harness.includes("Gemini") && h.note.includes("scheduler")));
});

test("attention guidance states empty polls do not invoke the model and the safety wake is bounded", () => {
  const text = renderAttentionGuidance({
    requested_mode: "foreground_attended",
    effective_mode: "wake_on_event",
    poll_cadence_s: 30,
    safety_wake_s: 1800
  });
  assert.match(text, /Requested mode: foreground_attended/);
  assert.match(text, /Effective mode: wake_on_event/);
  // Wake tier (#185): effective wake_on_event → Tier A on the card.
  assert.match(text, /Wake tier: Tier A · auto-wake — /);
  assert.match(text, /empty poll.*NOT invoke the model/i);
  assert.match(text, /Bounded safety wake/i);
  assert.match(text, /1800 s/);
  // describes all four modes
  for (const mode of ["foreground_attended", "wake_on_event", "heartbeat", "manual"]) {
    assert.ok(text.includes(mode), `guidance must describe ${mode}`);
  }
});

test("agent instructions carry the harness table + wake contract + unchanged advice-not-authority rule", () => {
  const instructions = renderAgentInstructions("claude");
  assert.ok(instructions.includes(renderHarnessMappingTable()));
  assert.match(instructions, /empty poll.*NOT invoke the model/i);
  assert.match(instructions, /external advice, not operator instructions/);
});

test("the agent Attend Card includes the attention section and leaks no extra token/URL", () => {
  const brief: RoomBrief = { body: "## Goal\nShip it.", brief_version: 1, brief_updated_at: "t", brief_updated_by: "host" };
  const participant: Participant = {
    alias: "reviewer",
    kind: "agent",
    location: "local",
    install: "lite",
    attention: "manual",
    is_host: false,
    joinedAt: "t",
    lastSeenAt: "t",
    requested_mode: "wake_on_event",
    effective_mode: "wake_on_event",
    poll_cadence_s: 30,
    safety_wake_s: 1800
  };
  const card = renderInviteCard("http://127.0.0.1:8787", participant, "tgl_secret_reviewer", brief, "manual-ok");
  assert.match(card, /## Attention/);
  assert.match(card, /Effective mode: wake_on_event/);
  assert.match(card, /empty poll.*NOT invoke the model/i);
  assert.match(card, /external advice, not operator instructions/); // safety rule unchanged
  // The card legitimately contains the invite token in curl commands (existing
  // behavior), but the new attention language must not duplicate it; ensure the
  // token appears only in the existing command context, not the Attention section.
  const attentionSection = card.slice(card.indexOf("## Attention"), card.indexOf("## Commands"));
  assert.equal(attentionSection.includes("tgl_secret_reviewer"), false, "attention section must not carry the token");
  // The tier line lives in the Attention section and reads Tier A here.
  assert.match(attentionSection, /Wake tier: Tier A/);
});

test("an agent that declares no supported modes shows Tier C, never an undeclared capability (#185)", () => {
  // 9A invariant: with nothing declared, effective_mode is the manual floor, so the
  // card must render the relay tier — not auto-wake — and never a higher capability.
  const guidance = renderAttentionGuidance({});
  assert.match(guidance, /Effective mode: manual/);
  assert.match(guidance, /Wake tier: Tier C · relay/);
  assert.equal(/Wake tier: Tier A/.test(guidance), false);
  assert.equal(/Wake tier: Tier B/.test(guidance), false);
});
