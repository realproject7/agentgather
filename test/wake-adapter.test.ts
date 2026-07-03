import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runWakeAdapterCommand } from "../src/cli/commands/wake-adapter/index.js";
import type { Participant } from "../src/protocol/index.js";
import { createRoom, writeParticipants } from "../src/storage/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
import { writeCurrent } from "../src/cli/state.js";

interface Fixture {
  root: string;
  roomId: string;
  baseUrl: string;
  agentToken: string;
  hostToken: string;
  close: () => Promise<void>;
}

function mkP(alias: string, kind: "agent" | "human", token: string): Participant {
  return {
    alias,
    kind,
    location: "local",
    install: kind === "human" ? "host" : "lite",
    attention: "manual",
    is_host: kind === "human",
    token_hash: participantTokenHash(token),
    joinedAt: "2026-06-21T00:00:00.000Z",
    lastSeenAt: "2026-06-21T00:00:00.000Z"
  };
}

async function startFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-wake-"));
  const roomId = "demo";
  const agentToken = "tgl_agent_wake";
  const hostToken = "tgl_host_wake";
  await createRoom({ root, roomId, hostAlias: "host" });
  await writeParticipants(root, roomId, [mkP("host", "human", hostToken), mkP("agent", "agent", agentToken)]);
  // Short wait-hold so an empty poll returns a heartbeat quickly in tests.
  const server = createRoomHttpServer({ root, roomId, baseUrl: "http://127.0.0.1:0", rateLimitPerMinute: 1000, waitHoldMs: 60 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The adapter reads current-room.json for the agent identity.
  await writeCurrent(root, { roomId, alias: "agent", token: agentToken, baseUrl });
  return {
    root,
    roomId,
    baseUrl,
    agentToken,
    hostToken,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

function makeCtx(home: string): { ctx: CliContext; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = { home, stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } } as unknown as CliContext;
  return { ctx, out: () => out.join(""), err: () => err.join("") };
}

async function postAsHost(fx: Fixture, text: string): Promise<void> {
  const res = await fetch(`${fx.baseUrl}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fx.hostToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  assert.equal(res.status, 201);
}

async function statusParticipant(fx: Fixture, alias: string): Promise<{ effective_mode?: string; supported_modes?: string[] }> {
  const res = await fetch(`${fx.baseUrl}/status`, { headers: { Authorization: `Bearer ${fx.hostToken}` } });
  const body = (await res.json()) as { participants: Array<{ alias: string; effective_mode?: string; supported_modes?: string[] }> };
  const found = body.participants.find((p) => p.alias === alias);
  assert.ok(found, `participant ${alias} present`);
  return found;
}

test("wake-adapter requires --exec (opt-in; no default command) (#187)", async () => {
  const fx = await startFixture();
  try {
    const { ctx, err } = makeCtx(fx.root);
    const code = await runWakeAdapterCommand([], ctx, { runCommand: async () => 0, sleep: async () => {} });
    assert.equal(code, 1);
    assert.match(err(), /--exec/);
  } finally {
    await fx.close();
  }
});

test("an actionable @mention spawns the command exactly once with pointer-only env, and declares wake_on_event (#187)", async () => {
  const fx = await startFixture();
  try {
    await postAsHost(fx, "@agent SUPERSECRETMSG please look");
    const spawns: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
    const { ctx } = makeCtx(fx.root);
    const code = await runWakeAdapterCommand(["--exec", "/bin/true", "--max-events", "1"], ctx, {
      runCommand: async (command, env) => {
        spawns.push({ command, env });
        return 0;
      },
      sleep: async () => {}
    });
    assert.equal(code, 0);
    assert.equal(spawns.length, 1);
    const first = spawns[0];
    assert.ok(first);
    assert.equal(first.command, "/bin/true");
    // Pointer-only env: room URL + since_id, never message content.
    assert.equal(first.env.AG_ROOM_URL, fx.baseUrl);
    assert.equal(typeof first.env.AG_SINCE_ID, "string");
    assert.equal(JSON.stringify(first.env).includes("SUPERSECRETMSG"), false);

    // The adapter declared wake_on_event on start → roster/tier reads Tier A (#185).
    const agent = await statusParticipant(fx, "agent");
    assert.ok((agent.supported_modes ?? []).includes("wake_on_event"));
    assert.equal(agent.effective_mode, "wake_on_event");
  } finally {
    await fx.close();
  }
});

test("empty polls and non-mention messages never spawn the command (#187)", async () => {
  const fx = await startFixture();
  try {
    // No messages: the poll returns a heartbeat only.
    let spawns = 0;
    const { ctx } = makeCtx(fx.root);
    await runWakeAdapterCommand(["--exec", "/bin/true", "--max-turns", "1"], ctx, {
      runCommand: async () => {
        spawns += 1;
        return 0;
      },
      sleep: async () => {}
    });
    assert.equal(spawns, 0);

    // A non-mention message is delivered but is not actionable → still no spawn.
    await postAsHost(fx, "hello room, nothing actionable here");
    const { ctx: ctx2 } = makeCtx(fx.root);
    await runWakeAdapterCommand(["--exec", "/bin/true", "--max-turns", "1"], ctx2, {
      runCommand: async () => {
        spawns += 1;
        return 0;
      },
      sleep: async () => {}
    });
    assert.equal(spawns, 0);
  } finally {
    await fx.close();
  }
});

test("the durable cursor survives an adapter restart — no duplicate delivery (#187)", async () => {
  const fx = await startFixture();
  try {
    await postAsHost(fx, "@agent first ping");
    let firstRun = 0;
    const { ctx } = makeCtx(fx.root);
    await runWakeAdapterCommand(["--exec", "/bin/true", "--max-events", "1"], ctx, {
      runCommand: async () => {
        firstRun += 1;
        return 0;
      },
      sleep: async () => {}
    });
    assert.equal(firstRun, 1);

    // Restart: the cursor advanced past "first ping", so a fresh run sees nothing new.
    let secondRun = 0;
    const { ctx: ctx2 } = makeCtx(fx.root);
    await runWakeAdapterCommand(["--exec", "/bin/true", "--max-turns", "1"], ctx2, {
      runCommand: async () => {
        secondRun += 1;
        return 0;
      },
      sleep: async () => {}
    });
    assert.equal(secondRun, 0);
  } finally {
    await fx.close();
  }
});

test("the real spawn passes NO room content in argv or env and is not shell-interpreted (#187)", async () => {
  const fx = await startFixture();
  try {
    const outFile = path.join(fx.root, "spawn-record.json");
    const script = path.join(fx.root, "record.mjs");
    await writeFile(
      script,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({`,
        "  argv: process.argv.slice(2),",
        "  agRoomUrl: process.env.AG_ROOM_URL || null,",
        "  agSinceId: process.env.AG_SINCE_ID || null,",
        '  leaksSecret: Object.values(process.env).some((v) => (v || "").includes("SUPERSECRETMSG"))',
        "}));",
        ""
      ].join("\n")
    );
    await chmod(script, 0o755);

    await postAsHost(fx, "@agent SUPERSECRETMSG `rm -rf /` $(whoami) payload");
    const { ctx } = makeCtx(fx.root);
    const code = await runWakeAdapterCommand(["--exec", script, "--max-events", "1"], ctx, { sleep: async () => {} });
    assert.equal(code, 0);

    const record = JSON.parse(await readFile(outFile, "utf8")) as {
      argv: string[];
      agRoomUrl: string | null;
      agSinceId: string | null;
      leaksSecret: boolean;
    };
    // No args at all → no room content (or shell metacharacters) reach argv.
    assert.deepEqual(record.argv, []);
    // The message text (incl. shell-looking substrings) never lands in env.
    assert.equal(record.leaksSecret, false);
    // Pointers are present and correct.
    assert.equal(record.agRoomUrl, fx.baseUrl);
    assert.match(String(record.agSinceId), /^[0-9]+$/);
  } finally {
    await fx.close();
  }
});
