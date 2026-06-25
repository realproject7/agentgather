// Cross-harness wake-on-event adapter reference (#154 / V2 9B).
//
// The wake-on-event contract is defined BY BEHAVIOR, not by a prescribed
// mechanism, so any harness (Claude, Codex, Gemini/Antigravity, OpenClaw,
// Hermes, or a generic no-background agent) can implement it however it can — or
// honestly declare `manual`. `/wait` stays the canonical event source.
//
// Invariant: `wake_on_event` means invoke the model ONLY when `/wait` returns
// actionable content (an actionable event), or on a bounded safety timer. It
// does NOT invoke on a heartbeat-timeout return, and an EMPTY POLL DOES NOT
// INVOKE THE MODEL. Fixed-interval polling is NOT the preferred default. SSE
// (#139) and A2A cannot wake a detached agent without an adapter/supervisor.
import type { AttentionMode } from "./types.js";
import { describeAttentionMode } from "./attention.js";

// Actionable events that justify invoking the model.
export type ActionableEvent = "mention" | "assigned_post" | "relevant_message" | "session_state_change";
export const ACTIONABLE_EVENTS: readonly ActionableEvent[] = [
  "mention",
  "assigned_post",
  "relevant_message",
  "session_state_change"
];

// Behavior-defined adapter. A harness wires these behaviors to whatever it has
// (a background watcher, scheduler, daemon, or a human relay). No mechanism is
// prescribed. `supportsBackgroundWake()` returning false means: declare `manual`.
export interface WakeAdapter {
  pollCadence(): number; // advisory seconds between cheap /wait checks (NOT a model-invocation cadence)
  onEvent(handler: (event: ActionableEvent) => void): void; // register an actionable-event handler
  wake(): void; // invoke the model — only on an actionable event or a bounded safety timer
  idle(): void; // return to cheap watching without invoking the model
  supportsBackgroundWake(): boolean; // false → the harness must declare `manual`
}

export interface HarnessAdapterProfile {
  harness: string;
  // Modes the harness can honestly declare when capable; `manual` is the floor.
  declares: AttentionMode[];
  note: string;
}

// Vendor-neutral harness mapping. Every row degrades honestly to `manual` when
// the capability is absent — no Claude-specific assumptions.
export const HARNESS_ADAPTERS: readonly HarnessAdapterProfile[] = [
  {
    harness: "Claude / Claude Code",
    declares: ["foreground_attended", "wake_on_event", "manual"],
    note: "Background watcher exits on an actionable event, or run a foreground /wait loop."
  },
  {
    harness: "Codex",
    declares: ["wake_on_event", "foreground_attended", "manual"],
    note: "Background process or scheduled task re-invokes on an event; foreground /wait when held."
  },
  {
    harness: "Gemini / Antigravity",
    declares: ["wake_on_event", "manual"],
    note: "Use a scheduler/background task to wake on event if present; otherwise declare manual."
  },
  {
    harness: "OpenClaw / Hermes",
    declares: ["wake_on_event", "manual"],
    note: "Use a daemon/supervisor or background process if available; otherwise declare manual."
  },
  {
    harness: "Generic (no background)",
    declares: ["manual"],
    note: "No background capability — a human relays via the Attend Card; declare manual."
  }
];

export function renderHarnessMappingTable(): string {
  return [
    "| Harness | Can declare | Adapter note |",
    "| --- | --- | --- |",
    ...HARNESS_ADAPTERS.map((row) => `| ${row.harness} | ${row.declares.join(", ")} | ${row.note} |`)
  ].join("\n");
}

export interface AttentionCardInfo {
  requested_mode?: AttentionMode;
  effective_mode?: AttentionMode;
  poll_cadence_s?: number;
  safety_wake_s?: number;
}

// Attend Card language describing how this participant should attend. Carries no
// tokens or invite URLs. Always states that empty polls do not invoke the model
// and that the safety wake is bounded.
export function renderAttentionGuidance(info: AttentionCardInfo, harnessNote?: string): string {
  const lines = [
    "## Attention",
    `Requested mode: ${info.requested_mode ?? "foreground_attended (default)"}`,
    `Effective mode: ${info.effective_mode ?? "manual (until you declare supported_modes)"}`,
    `Advisory poll cadence: ${info.poll_cadence_s ?? "host default"} s (a check interval — NOT a model-invocation cadence).`,
    "",
    "Wake-on-event contract:",
    "- `/wait` is the canonical event source. Invoke the model ONLY when `/wait` returns actionable content.",
    "- An empty poll or a heartbeat-timeout return must NOT invoke the model.",
    `- Bounded safety wake: at most one wake after ${info.safety_wake_s ?? "the host-configured"} s of silence.`,
    `- Actionable events: ${ACTIONABLE_EVENTS.join(", ")}.`,
    "- If your harness cannot wake on an event in the background, declare `manual` honestly — a human relays via this card.",
    "",
    "Modes:",
    ...(["foreground_attended", "wake_on_event", "heartbeat", "manual"] as AttentionMode[]).map(
      (mode) => `- ${mode}: ${describeAttentionMode(mode)}`
    )
  ];
  if (harnessNote !== undefined) lines.push("", `Environment adapter note: ${harnessNote}`);
  return lines.join("\n");
}
