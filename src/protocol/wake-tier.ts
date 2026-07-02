// Wake-capability tier (V2.1 A, #185). A presentation-only derivation over the
// existing 9A attention modes — NO new protocol state, no wire fields. It renders
// wake capability honestly on attend/forum cards and the roster so a foreground
// "online" agent is not mistaken for one that can actually be woken (the
// "online-dot lie"). Derive the tier from the NEGOTIATED effective mode, which is
// always a declared mode or the `manual` floor, so a tier never claims an
// undeclared capability. Copy is behavior-defined and vendor-neutral, matching the
// 9B harness mapping (adapter.ts) — no harness-specific promises.

import type { AttentionMode } from "./types.js";

export type WakeTier = "A" | "B" | "C";

// A = auto-wake on actionable events (wake_on_event: the one mode with an external
// event entry point). C = manual/relay (manual: a human carries the nudge).
// B = everything in between — foreground-capable or periodic, but with no
// event-driven wake (foreground_attended, heartbeat).
export function wakeTierForMode(mode: AttentionMode): WakeTier {
  if (mode === "wake_on_event") return "A";
  if (mode === "manual") return "C";
  return "B";
}

export interface WakeTierCopy {
  tier: WakeTier;
  // Short chip/line label, e.g. "Tier A · auto-wake".
  label: string;
  // One honest sentence of what the tier means for the humans in the room.
  headline: string;
}

const WAKE_TIER_COPY: Readonly<Record<WakeTier, { label: string; headline: string }>> = {
  A: {
    label: "Tier A · auto-wake",
    headline: "Wakes on actionable events — reachable even when unattended (empty polls do not wake it)."
  },
  B: {
    label: "Tier B · notify",
    headline: "No event-driven wake — reach it with a notification; a human nudge or its next check-in brings it back."
  },
  C: {
    label: "Tier C · relay",
    headline: "Manual relay — a human carries the “your turn” nudge; it is not woken on its own."
  }
};

export function describeWakeTier(tier: WakeTier): WakeTierCopy {
  return { tier, ...WAKE_TIER_COPY[tier] };
}
