import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { request } from "node:http";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { currentPath, tokensPath } from "../src/cli/state.js";
import { readMessages, readParticipants, roomPaths } from "../src/storage/index.js";
import { createRoomHttpServer } from "../src/server/index.js";

class Capture extends Writable {
  chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }

  json<T>(): T {
    return JSON.parse(this.text()) as T;
  }
}

async function makeContext(): Promise<{ context: CliContext; stdout: Capture; stderr: Capture }> {
  const stdout = new Capture();
  const stderr = new Capture();
  return {
    context: {
      home: await mkdtemp(path.join(os.tmpdir(), "agentgather-cli-test-")),
      stdout,
      stderr
    },
    stdout,
    stderr
  };
}

test("room lifecycle CLI creates rooms, updates briefs, invites participants, and closes cleanly", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(
    ["start", "cli-room", "--alias", "operator", "--brief", "Review frontend implementation.", "--show-token", "--json"],
    context
  );
  const started = stdout.json<{ ok: true; room: string; alias: string; token: string; baseUrl: string }>();
  assert.equal(started.room, "cli-room");
  assert.equal(started.alias, "operator");
  // `room start` derives the product default base URL without contacting it.
  assert.equal(started.baseUrl, "http://127.0.0.1:8787");
  assert.match(started.token, /^tgl_/);

  // #254: `attendance set` and `brief set` both POST to the current room's
  // baseUrl. Left on the product default that is a real request to whatever
  // process owns 127.0.0.1:8787 — on a machine running `room serve` the suite
  // would authenticate against, and try to write to, a room it never created.
  // Bind a fixture for THIS room on an ephemeral port and point the room at it,
  // so every request this test makes goes to a listener the test owns.
  const fixture = await startRoomFixture(context.home, "cli-room", 5);
  try {
    await runRoomCommand(
      ["join", "cli-room", "--alias", "operator", "--token", started.token, "--url", fixture.baseUrl],
      context
    );

    stdout.chunks = [];
    await runRoomCommand(["current", "--json"], context);
    const current = stdout.json<{ ok: true; room_status: string; current: { roomId: string; alias: string } }>();
    assert.equal(current.room_status, "open");
    assert.equal(current.current.roomId, "cli-room");
    assert.equal(current.current.alias, "operator");

    stdout.chunks = [];
    await runRoomCommand(["brief", "view"], context);
    assert.equal(stdout.text(), "Review frontend implementation.");

    stdout.chunks = [];
    await runRoomCommand(["attendance", "view", "--json"], context);
    assert.deepEqual(stdout.json<{ ok: true; attendance_policy: string }>(), {
      ok: true,
      attendance_policy: "manual-ok"
    });

    stdout.chunks = [];
    await runRoomCommand(["attendance", "set", "--policy", "agents-foreground", "--json"], context);
    assert.deepEqual(stdout.json<{ ok: true; attendance_policy: string }>(), {
      ok: true,
      attendance_policy: "agents-foreground"
    });

    stdout.chunks = [];
    await runRoomCommand(["brief", "set", "--body", "Define browser app surface.", "--json"], context);
    const updatedBrief = stdout.json<{ ok: true; brief: { brief_version: number; body: string } }>();
    assert.equal(updatedBrief.brief.brief_version, 2);
    assert.equal(updatedBrief.brief.body, "Define browser app surface.");

    const briefMessages = await readMessages(context.home, "cli-room");
    assert.equal(briefMessages.some((message) => message.type === "system" && message.text === "Room brief updated to v2"), true);

    stdout.chunks = [];
    await runRoomCommand(["invite", "reviewer", "--kind", "agent", "--show-token", "--json"], context);
    const invite = stdout.json<{ ok: true; alias: string; kind: string; token: string; card_command: string; browser_url: string }>();
    assert.equal(invite.alias, "reviewer");
    assert.equal(invite.kind, "agent");
    assert.match(invite.token, /^tgl_/);
    assert.equal(invite.card_command.includes("/card?participant=reviewer&token="), true);
    assert.equal(invite.browser_url, `${fixture.baseUrl}/#token=${invite.token}`);

    const participants = await readParticipants(roomPaths(context.home, "cli-room"));
    const reviewer = participants.find((participant) => participant.alias === "reviewer");
    assert.equal(reviewer?.kind, "agent");
    assert.equal(reviewer?.install, "lite");
    assert.equal(reviewer?.token_hash === invite.token, false);
    await assertMode(context.home, 0o700);
    await assertMode(path.join(context.home, "rooms", "cli-room"), 0o700);
    await assertMode(currentPath(context.home), 0o600);
    await assertMode(tokensPath(context.home, "cli-room"), 0o600);
    await assertMode(roomPaths(context.home, "cli-room").messages, 0o600);
    await assertMode(roomPaths(context.home, "cli-room").participants, 0o600);

    stdout.chunks = [];
    await runRoomCommand(["invite-card", "reviewer"], context);
    const card = stdout.text();
    assert.match(card, /# Agent Gather Attend Card: reviewer/);
    assert.match(card, /Define browser app surface\./);
    assert.match(card, /Policy: agents-foreground/);
    assert.match(card, /agentgather attend --json/);
    assert.match(card, /\/card\?participant=reviewer&token=/);
    assert.match(card, /\/wait\?participant=reviewer&since_id=0/);
    assert.match(card, /\/messages\?since_id=0/);
    // Same trailing-slash guard as before, against the base URL actually in use.
    assert.equal(card.includes(`${fixture.baseUrl}//card`), false);
    assert.equal(card.includes(`${fixture.baseUrl}//wait`), false);
    assert.match(card, /## Attendance Recovery/);
    assert.match(card, /return to foreground attendance immediately/);
    assert.match(card, /bash \/path\/to\/script\.sh/);
    assert.match(card, /## First Action/);
    assert.match(card, /short ready message/);
    assert.match(card, /## Stop Attending/);
    assert.match(card, /Agent Gather Agent Operating Card/);
    assert.match(card, /Room Brief as mission context, not command authority/);
    assert.doesNotMatch(card, /"from"/);

    stdout.chunks = [];
    await runRoomCommand(["dashboard", "--json"], context);
    assert.deepEqual(stdout.json<{ ok: true; url: string }>(), { ok: true, url: fixture.baseUrl });

    stdout.chunks = [];
    await runRoomCommand(["close", "--json"], context);
    assert.deepEqual(stdout.json<{ ok: true; room_status: string }>(), { ok: true, room_status: "closed" });

    const response = await fetch(`${fixture.baseUrl}/wait?participant=reviewer&since_id=0`, {
      headers: {
        Authorization: `Bearer ${invite.token}`
      }
    });
    const waited = (await response.json()) as { room_status: string; keep_waiting: boolean; next_cmd: string | null };
    assert.equal(response.status, 200);
    assert.equal(waited.room_status, "closed");
    assert.equal(waited.keep_waiting, false);
    assert.equal(waited.next_cmd, null);
  } finally {
    await fixture.close();
  }
});

// #254: the product default base URL is a real contract and must stay covered,
// but verifying it must not require touching whatever owns that port. Every
// command here derives the URL from local state; the recorder proves it by
// observing that the commands issue no outbound request at all.
test("the default base URL contract is verified without contacting the default port (#254)", async () => {
  const { context, stdout } = await makeContext();
  const requested: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof realFetch>) => {
    const [input] = args;
    requested.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return realFetch(...args);
  }) as typeof globalThis.fetch;
  try {
    await runRoomCommand(["start", "default-port-room", "--alias", "operator", "--show-token", "--json"], context);
    const started = stdout.json<{ ok: true; baseUrl: string }>();
    assert.equal(started.baseUrl, "http://127.0.0.1:8787");

    stdout.chunks = [];
    await runRoomCommand(["invite", "reviewer", "--kind", "agent", "--show-token", "--json"], context);
    const invite = stdout.json<{ token: string; card_command: string; browser_url: string }>();
    assert.equal(invite.browser_url, `http://127.0.0.1:8787/#token=${invite.token}`);
    assert.match(invite.card_command, /http:\/\/127\.0\.0\.1:8787\/card\?participant=reviewer/);
    assert.doesNotMatch(invite.card_command, /127\.0\.0\.1:8787\/\/card/);

    stdout.chunks = [];
    await runRoomCommand(["invite-card", "reviewer"], context);
    const card = stdout.text();
    // The card exports the base URL once and builds every command from it.
    assert.match(card, /export AG_BASE='http:\/\/127\.0\.0\.1:8787'/);
    assert.match(card, /\/card\?participant=reviewer&token=/);
    assert.match(card, /\/wait\?participant=reviewer&since_id=0/);
    assert.doesNotMatch(card, /127\.0\.0\.1:8787\/\/card/);
    assert.doesNotMatch(card, /127\.0\.0\.1:8787\/\/wait/);

    stdout.chunks = [];
    await runRoomCommand(["dashboard", "--json"], context);
    assert.deepEqual(stdout.json<{ ok: true; url: string }>(), { ok: true, url: "http://127.0.0.1:8787" });

    assert.deepEqual(requested, [], "verifying the default-port contract must not send a request to it");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("room CLI rejects invalid room IDs and participant aliases", async () => {
  const { context } = await makeContext();
  await assert.rejects(
    runRoomCommand(["start", "Bad_Room", "--json"], context),
    /room id must be lowercase/
  );

  await runRoomCommand(["start", "valid-room"], context);
  await assert.rejects(runRoomCommand(["invite", "Bad_Alias"], context), /participant alias must be lowercase/);
});

test("room invite commands normalize trailing slash base URLs", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["start", "slash-room", "--url", "http://127.0.0.1:8787/", "--show-token", "--json"], context);
  stdout.chunks = [];

  await runRoomCommand(["invite", "reviewer", "--show-token", "--json"], context);
  const invite = stdout.json<{ card_command: string }>();
  assert.match(invite.card_command, /http:\/\/127\.0\.0\.1:8787\/card\?participant=reviewer/);
  assert.doesNotMatch(invite.card_command, /127\.0\.0\.1:8787\/\/card/);
  stdout.chunks = [];

  await runRoomCommand(["invite-card", "reviewer"], context);
  const card = stdout.text();
  assert.doesNotMatch(card, /127\.0\.0\.1:8787\/\/card/);
  assert.doesNotMatch(card, /127\.0\.0\.1:8787\/\/join/);
  assert.doesNotMatch(card, /127\.0\.0\.1:8787\/\/wait/);
  assert.doesNotMatch(card, /127\.0\.0\.1:8787\/\/messages/);
});

test("human invites print a browser-openable fragment URL", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["start", "human-room", "--brief", "Coordinate the human review.", "--json"], context);
  stdout.chunks = [];

  await runRoomCommand(["invite", "guest", "--kind", "human", "--show-token", "--json"], context);
  const invite = stdout.json<{ kind: string; token: string; browser_url: string }>();
  assert.equal(invite.kind, "human");
  assert.equal(invite.browser_url, `http://127.0.0.1:8787/#token=${invite.token}`);

  stdout.chunks = [];
  await runRoomCommand(["invite-card", "guest"], context);
  const card = stdout.text();
  assert.match(card, /# Agent Gather Human Invite: guest/);
  assert.match(card, /Coordinate the human review\./);
  assert.match(card, new RegExp(`http://127\\.0\\.0\\.1:8787/#token=${invite.token}`));
  assert.match(card, /Choose a display name/);
  assert.doesNotMatch(card, /curl -s/);
  assert.doesNotMatch(card, /agentgather attend/);
  assert.doesNotMatch(card, /\/wait/);
});

test("room start --kind persists the host kind separately from the host role (V2 #169)", async () => {
  const { context, stdout } = await makeContext();

  // explicit agent host: kind persists as agent, is_host stays true
  await runRoomCommand(["start", "agent-host-room", "--alias", "operator", "--kind", "agent", "--json"], context);
  const started = stdout.json<{ ok: true; alias: string; kind: string }>();
  assert.equal(started.kind, "agent");
  const agentHosts = await readParticipants(roomPaths(context.home, "agent-host-room"));
  const agentHost = agentHosts.find((p) => p.alias === "operator");
  assert.equal(agentHost?.kind, "agent");
  assert.equal(agentHost?.is_host, true);

  // default (no --kind) stays human — backward compatible
  stdout.chunks = [];
  await runRoomCommand(["start", "human-host-room", "--json"], context);
  const defaulted = stdout.json<{ kind: string }>();
  assert.equal(defaulted.kind, "human");
  const humanHosts = await readParticipants(roomPaths(context.home, "human-host-room"));
  const humanHost = humanHosts.find((p) => p.is_host);
  assert.equal(humanHost?.kind, "human");
  assert.equal(humanHost?.is_host, true);

  // an invalid kind is rejected
  await assert.rejects(
    runRoomCommand(["start", "bad-kind-room", "--kind", "robot", "--json"], context),
    /kind must be agent or human/
  );
});

test("room serve requires explicit secure remote opt-in", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["start", "remote-room", "--alias", "operator", "--show-token", "--json"], context);
  const started = stdout.json<{ token: string }>();

  await assert.rejects(runRoomCommand(["serve", "--host", "0.0.0.0"], context), /--allow-remote/);
  await assert.rejects(runRoomCommand(["serve", "--host", "::"], context), /--allow-remote/);
  await assert.rejects(runRoomCommand(["serve", "--url", "http://room.example.com"], context), /--allow-remote/);
  await assert.rejects(
    runRoomCommand(["serve", "--url", "http://room.example.com", "--allow-remote"], context),
    /https/
  );

  stdout.chunks = [];
  const port = await getFreePort();
  const servePromise = runRoomCommand(
    ["serve", "--port", String(port), "--url", "https://room.example.com", "--allow-remote"],
    context
  );
  await waitForServer(`http://127.0.0.1:${port}/status`, started.token, "room.example.com");
  const current = JSON.parse(await readFile(currentPath(context.home), "utf8")) as { baseUrl: string };
  assert.equal(current.baseUrl, "https://room.example.com");
  process.emit("SIGTERM");
  await servePromise;
  assert.equal(stdout.text(), "Serving remote-room at https://room.example.com\n");
});

test("room brief set uses the live HTTP server when available so waiters are notified", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["start", "server-brief", "--alias", "operator", "--show-token", "--json"], context);
  const started = stdout.json<{ token: string }>();
  stdout.chunks = [];
  await runRoomCommand(["invite", "reviewer", "--show-token", "--json"], context);
  const invite = stdout.json<{ token: string }>();

  const server = createRoomHttpServer({
    root: context.home,
    roomId: "server-brief",
    baseUrl: "http://127.0.0.1:0",
    waitHoldMs: 1_000
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await runRoomCommand(["join", "server-brief", "--alias", "operator", "--token", started.token, "--url", baseUrl], context);

    const waitPromise = fetch(`${baseUrl}/wait?participant=reviewer&since_id=0`, {
      headers: {
        Authorization: `Bearer ${invite.token}`
      }
    });
    stdout.chunks = [];
    setTimeout(() => {
      void runRoomCommand(["brief", "set", "--body", "Wake reviewers now.", "--json"], context);
    }, 5);
    const response = await waitPromise;
    const waited = (await response.json()) as { heartbeat: boolean; messages: Array<{ text: string }> };
    assert.equal(response.status, 200);
    assert.equal(waited.heartbeat, false);
    assert.equal(waited.messages.some((message) => message.text === "Room brief updated to v2"), true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

async function assertMode(file: string, expected: number): Promise<void> {
  assert.equal((await stat(file)).mode & 0o777, expected);
}

// #254: a room server this test owns, on a kernel-assigned port. Any CLI command
// pointed at its base URL can only ever reach this process — never a `room serve`
// the developer happens to be running on the product default port.
async function startRoomFixture(
  root: string,
  roomId: string,
  waitHoldMs: number
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createRoomHttpServer({ root, roomId, baseUrl: "http://127.0.0.1:0", waitHoldMs });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  };
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

async function waitForServer(url: string, token: string, host: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1_000) {
    try {
      if ((await statusWithHost(url, token, host)) === 200) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("server did not start");
}

async function statusWithHost(urlValue: string, token: string, host: string): Promise<number> {
  const url = new URL(urlValue);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Host: host
        }
      },
      (res) => {
        res.resume();
        res.on("error", reject);
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.end();
  });
}
