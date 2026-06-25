import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { buildRuntimeLaunchPlan, resolveRuntimeState, sanitizePublicUrl } from "../src/server/index.js";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";

const baseInput = {
  home: "/home/agent/.agentgather",
  roomId: "demo",
  port: 8787,
  publicUrl: "http://127.0.0.1:8787",
  logPath: "/home/agent/.agentgather/rooms/demo/serve.log",
  sessionName: "agentgather-demo"
};

test("runtime state classification: running / unreachable / manual-run-required", () => {
  assert.equal(resolveRuntimeState(true, true), "runtime-running");
  assert.equal(resolveRuntimeState(false, true), "runtime-running");
  assert.equal(resolveRuntimeState(true, false), "runtime-unreachable");
  assert.equal(resolveRuntimeState(false, false), "manual-run-required");
});

test("detached-tmux plan: detached serve command with home/port/url/log + stop/status", () => {
  const plan = buildRuntimeLaunchPlan({ ...baseInput, tmuxAvailable: true, runtimeReachable: false });
  assert.equal(plan.strategy, "detached-tmux");
  assert.equal(plan.runtimeState, "runtime-unreachable");
  assert.match(plan.serveCommand, /AGENTGATHER_HOME=/);
  assert.match(plan.serveCommand, /room serve --port 8787/);
  assert.ok(plan.detachedCommand !== null);
  assert.match(plan.detachedCommand ?? "", /tmux new-session -d -s/);
  assert.match(plan.detachedCommand ?? "", /serve\.log/);
  assert.match(plan.stopCommand, /tmux kill-session -t/);
  assert.match(plan.statusCommand, /tmux has-session -t/);
  assert.match(plan.ownership, /does not hold the server in the foreground/);
});

test("manual-operator plan: copy-pastable serve command, no tmux, human owns the runtime", () => {
  const plan = buildRuntimeLaunchPlan({ ...baseInput, tmuxAvailable: false, runtimeReachable: false });
  assert.equal(plan.strategy, "manual-operator");
  assert.equal(plan.runtimeState, "manual-run-required");
  assert.equal(plan.detachedCommand, null);
  assert.match(plan.serveCommand, /agentgather room serve/);
  assert.match(plan.ownership, /human operator must run/);
});

test("a running runtime reports runtime-running regardless of runner type", () => {
  assert.equal(buildRuntimeLaunchPlan({ ...baseInput, tmuxAvailable: true, runtimeReachable: true }).runtimeState, "runtime-running");
  assert.equal(buildRuntimeLaunchPlan({ ...baseInput, tmuxAvailable: false, runtimeReachable: true }).runtimeState, "runtime-running");
});

test("no plan command leaks a raw token or invite URL", () => {
  for (const tmux of [true, false]) {
    const plan = buildRuntimeLaunchPlan({ ...baseInput, tmuxAvailable: tmux, runtimeReachable: false });
    const blob = JSON.stringify(plan);
    assert.equal(blob.includes("tgl_"), false);
    assert.equal(blob.includes("#token="), false);
    assert.equal(blob.includes("token"), false);
  }
});

test("a token-bearing invite URL is stripped from every generated command (no leak)", () => {
  const tokenUrl = "http://127.0.0.1:8787/slug/?token=tgl_SECRET#token=tgl_SECRET";
  // sanitizePublicUrl drops query/fragment/userinfo, keeps scheme/host/port/path.
  const clean = sanitizePublicUrl(tokenUrl);
  assert.equal(clean.includes("tgl_SECRET"), false);
  assert.match(clean, /\/slug\//);

  for (const tmux of [true, false]) {
    const plan = buildRuntimeLaunchPlan({ ...baseInput, publicUrl: tokenUrl, tmuxAvailable: tmux, runtimeReachable: false });
    const blob = JSON.stringify(plan);
    assert.equal(blob.includes("tgl_SECRET"), false, "no command/status may carry the token");
    assert.equal(blob.includes("#token="), false);
    assert.equal(blob.includes("?token="), false);
  }
  // sanitize is idempotent and leaves credential-free URLs untouched.
  assert.equal(sanitizePublicUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787/");
});

test("port validation rejects out-of-range values", () => {
  assert.throws(() => buildRuntimeLaunchPlan({ ...baseInput, port: 0, tmuxAvailable: true, runtimeReachable: false }));
  assert.throws(() => buildRuntimeLaunchPlan({ ...baseInput, port: 70_000, tmuxAvailable: false, runtimeReachable: false }));
});

// ---- CLI surface (plan mode: never spawns a process) ----

class Capture extends Writable {
  chunks: string[] = [];
  _write(c: Buffer | string, _e: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(c) ? c.toString("utf8") : c);
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
  json<T>(): T {
    return JSON.parse(this.text()) as T;
  }
}

async function makeContext(): Promise<{ context: CliContext; stdout: Capture }> {
  const stdout = new Capture();
  const stderr = new Capture();
  return { context: { home: await mkdtemp(path.join(os.tmpdir(), "agentgather-t7a-")), stdout, stderr }, stdout };
}

test("room launch (plan mode) prints a token-free runtime plan and does not spawn", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["create-boardroom", "demo", "--url", "http://127.0.0.1:8799", "--json"], context);
  stdout.chunks.length = 0;
  await runRoomCommand(["launch", "--json"], context); // no --detach: never spawns
  const out = stdout.json<{
    ok: true;
    launched: boolean;
    runtimeState: string;
    serveCommand: string;
    statusCommand: string;
    stopCommand: string;
  }>();
  assert.equal(out.launched, false);
  assert.ok(["runtime-running", "runtime-unreachable", "manual-run-required"].includes(out.runtimeState));
  assert.match(out.serveCommand, /AGENTGATHER_HOME=/);
  assert.equal(out.serveCommand.includes("tgl_"), false);
  assert.equal(stdout.text().includes("tgl_"), false);
});

test("room launch --url with a token fragment never echoes the token", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["create-boardroom", "demo", "--json"], context);
  stdout.chunks.length = 0;
  await runRoomCommand(["launch", "--url", "http://127.0.0.1:8797/#token=tgl_SECRET", "--json"], context);
  const text = stdout.text();
  assert.equal(text.includes("tgl_SECRET"), false, "launch output must not echo a token-bearing URL");
  assert.equal(text.includes("#token="), false);
});

test("room runtime-status reports a valid runtime state without a server", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["create-boardroom", "demo", "--url", "http://127.0.0.1:8798", "--json"], context);
  stdout.chunks.length = 0;
  await runRoomCommand(["runtime-status", "--json"], context);
  const out = stdout.json<{ ok: true; runtime_state: string }>();
  // No server is listening on the test port → not running.
  assert.ok(["runtime-unreachable", "manual-run-required"].includes(out.runtime_state));
});
