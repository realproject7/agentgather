import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRoom, readParticipants, roomPaths, writeParticipants } from "../src/storage/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { writeCurrent } from "../src/cli/state.js";
import {
  ATTENTION_MODES,
  isDegraded,
  negotiateEffectiveMode,
  negotiateParticipantAttention,
  normalizeSupportedModes,
  type AttentionMode,
  type Participant
} from "../src/protocol/index.js";

// ---- pure negotiation ----

test("attention modes are ordered most → least capable", () => {
  assert.deepEqual([...ATTENTION_MODES], ["foreground_attended", "wake_on_event", "heartbeat", "manual"]);
});

test("negotiateEffectiveMode: most-capable mode not exceeding requested, in supported; else manual", () => {
  // host requests foreground; participant supports wake+manual → best ≤ foreground = wake
  assert.equal(negotiateEffectiveMode(["wake_on_event", "manual"], "foreground_attended"), "wake_on_event");
  // host requests wake; participant supports foreground+heartbeat → foreground exceeds wake, so heartbeat
  assert.equal(negotiateEffectiveMode(["foreground_attended", "heartbeat"], "wake_on_event"), "heartbeat");
  // exact support
  assert.equal(negotiateEffectiveMode(["foreground_attended"], "foreground_attended"), "foreground_attended");
  // no match (supports only foreground, host requests manual) → manual floor
  assert.equal(negotiateEffectiveMode(["foreground_attended"], "manual"), "manual");
  // no declared support → manual
  assert.equal(negotiateEffectiveMode([], "foreground_attended"), "manual");
});

test("normalizeSupportedModes validates, dedupes, and orders most → least", () => {
  assert.deepEqual(normalizeSupportedModes(["manual", "foreground_attended", "manual"]), ["foreground_attended", "manual"]);
  assert.throws(() => normalizeSupportedModes(["managed"])); // post-MVP, not in the enum
  assert.throws(() => normalizeSupportedModes(["nonsense"]));
});

test("isDegraded is true only when effective is less capable than requested", () => {
  assert.equal(isDegraded("heartbeat", "foreground_attended"), true);
  assert.equal(isDegraded("foreground_attended", "foreground_attended"), false);
  assert.equal(isDegraded("manual", "wake_on_event"), true);
});

test("negotiateParticipantAttention: undeclared support degrades to manual; undeclared request accepts max", () => {
  const base = {
    alias: "a",
    kind: "agent",
    location: "local",
    install: "lite",
    attention: "manual",
    is_host: false,
    joinedAt: "t",
    lastSeenAt: "t"
  } as Participant;
  // no support declared → manual (honest)
  assert.equal(negotiateParticipantAttention(base).effective_mode, "manual");
  // supports wake, no host request → request defaults to most capable, effective = wake
  assert.equal(
    negotiateParticipantAttention({ ...base, supported_modes: ["wake_on_event"] }).effective_mode,
    "wake_on_event"
  );
});

// ---- server negotiation (declare on /profile, re-negotiate on /join) ----

const mkP = (alias: string, kind: Participant["kind"], token: string, extra: Partial<Participant> = {}): Participant => ({
  alias,
  kind,
  location: "local",
  install: "lite",
  attention: "manual",
  is_host: kind === "human" && alias === "host",
  token_hash: participantTokenHash(token),
  joinedAt: "2026-06-21T00:00:00.000Z",
  lastSeenAt: "2026-06-21T00:00:00.000Z",
  ...extra
});

async function startFixture(agentExtra: Partial<Participant> = {}): Promise<{
  baseUrl: string;
  root: string;
  roomId: string;
  agentToken: string;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-9a-"));
  const roomId = "demo";
  const agentToken = "tgl_agent";
  await createRoom({ root, roomId, hostAlias: "host" });
  await writeParticipants(root, roomId, [mkP("host", "human", "tgl_host"), mkP("agent", "agent", agentToken, agentExtra)]);
  const server = createRoomHttpServer({ root, roomId, baseUrl: "http://127.0.0.1:0", rateLimitPerMinute: 1000 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, root, roomId, agentToken, close: () => new Promise((r) => server.close(() => r())) };
}

async function profile(baseUrl: string, token: string, body: unknown): Promise<{ status: number; participant: { effective_mode?: AttentionMode; requested_mode?: AttentionMode; supported_modes?: AttentionMode[] } }> {
  const res = await fetch(`${baseUrl}/profile`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = (await res.json()) as { participant: { effective_mode?: AttentionMode; requested_mode?: AttentionMode; supported_modes?: AttentionMode[] } };
  return { status: res.status, participant: json.participant };
}

test("a participant declares supported_modes; server negotiates + persists + displays effective_mode (degraded shows both)", async () => {
  // Host requested foreground; the agent can only do heartbeat → honest degrade.
  const fx = await startFixture({ requested_mode: "foreground_attended" });
  try {
    const res = await profile(fx.baseUrl, fx.agentToken, { display_name: "Agent", supported_modes: ["heartbeat"] });
    assert.equal(res.status, 200);
    assert.equal(res.participant.requested_mode, "foreground_attended");
    assert.equal(res.participant.effective_mode, "heartbeat");
    assert.deepEqual(res.participant.supported_modes, ["heartbeat"]);
    // public participant carries no token hash but does carry the negotiated modes
    assert.equal((res.participant as { token_hash?: unknown }).token_hash, undefined);

    // persisted on disk
    const stored = (await readParticipants(roomPaths(fx.root, "demo"))).find((p) => p.alias === "agent");
    assert.equal(stored?.effective_mode, "heartbeat");
  } finally {
    await fx.close();
  }
});

test("a no-background participant degrades honestly to manual and the roster shows no undeclared capability", async () => {
  const fx = await startFixture({ requested_mode: "foreground_attended" });
  try {
    const res = await profile(fx.baseUrl, fx.agentToken, { display_name: "Agent", supported_modes: [] });
    assert.equal(res.participant.effective_mode, "manual");
    assert.deepEqual(res.participant.supported_modes, []);
    // effective is the manual floor — never a capability the participant didn't declare
    const supported: AttentionMode[] = res.participant.supported_modes ?? [];
    assert.ok(res.participant.effective_mode === "manual" || supported.includes(res.participant.effective_mode as AttentionMode));
  } finally {
    await fx.close();
  }
});

test("declaring supported_modes on POST /join persists them and negotiates effective_mode (regression for the drop-to-[] bug)", async () => {
  // Host requests wake_on_event; the agent has NOT declared support yet (stored
  // default is []). Previously /join ignored its body, so the declaration was
  // dropped and the participant stayed supported_modes:[] / effective_mode:manual.
  const fx = await startFixture({ requested_mode: "wake_on_event" });
  try {
    const res = await fetch(`${fx.baseUrl}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fx.agentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ supported_modes: ["wake_on_event"], poll_cadence_s: 45, safety_wake_s: 600 })
    });
    assert.equal(res.status, 200);

    // persisted on disk: declaration kept, effective_mode negotiated (not manual)
    const stored = (await readParticipants(roomPaths(fx.root, "demo"))).find((p) => p.alias === "agent");
    assert.deepEqual(stored?.supported_modes, ["wake_on_event"]);
    assert.equal(stored?.effective_mode, "wake_on_event");
    assert.equal(stored?.poll_cadence_s, 45);
    assert.equal(stored?.safety_wake_s, 600);

    // roster/status reflects the negotiated mode (no raw token leaked)
    const status = (await (await fetch(`${fx.baseUrl}/status`, { headers: { Authorization: `Bearer ${fx.agentToken}` } })).json()) as {
      participants: Array<{ alias: string; supported_modes?: AttentionMode[]; effective_mode?: AttentionMode; token_hash?: unknown }>;
    };
    const me = status.participants.find((p) => p.alias === "agent");
    assert.equal(me?.effective_mode, "wake_on_event");
    assert.deepEqual(me?.supported_modes, ["wake_on_event"]);
    assert.equal(me?.token_hash, undefined);
  } finally {
    await fx.close();
  }
});

test("re-negotiation on reconnect (POST /join) recomputes effective_mode from stored declaration", async () => {
  const fx = await startFixture({ requested_mode: "wake_on_event", supported_modes: ["foreground_attended", "heartbeat"] });
  try {
    const res = await fetch(`${fx.baseUrl}/join`, { method: "POST", headers: { Authorization: `Bearer ${fx.agentToken}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    const stored = (await readParticipants(roomPaths(fx.root, "demo"))).find((p) => p.alias === "agent");
    // requested wake; supports foreground+heartbeat → foreground exceeds wake, so heartbeat
    assert.equal(stored?.effective_mode, "heartbeat");
  } finally {
    await fx.close();
  }
});

test("invalid supported_modes (post-MVP managed) is rejected by the server", async () => {
  const fx = await startFixture();
  try {
    const res = await fetch(`${fx.baseUrl}/profile`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fx.agentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: "Agent", supported_modes: ["managed"] })
    });
    assert.equal(res.status, 400);
  } finally {
    await fx.close();
  }
});

test("room invite --mode sets the host requested_mode on the participant", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-9a-cli-"));
  await createRoom({ root, roomId: "demo", hostAlias: "host" });
  await writeParticipants(root, "demo", [mkP("host", "human", "tgl_host")]);
  await writeCurrent(root, { roomId: "demo", alias: "host", token: "tgl_host", baseUrl: "http://127.0.0.1:8787" });
  const out: string[] = [];
  const ctx = { home: root, stdout: { write: (s: string) => out.push(s) }, stderr: { write: () => {} } } as never;
  await runRoomCommand(["invite", "reviewer", "--kind", "agent", "--mode", "wake_on_event", "--json"], ctx);
  const stored = (await readParticipants(roomPaths(root, "demo"))).find((p) => p.alias === "reviewer");
  assert.equal(stored?.requested_mode, "wake_on_event");
  assert.equal(out.join("").includes("wake_on_event"), false, "invite output need not echo the requested mode");
});
