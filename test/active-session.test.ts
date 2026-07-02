import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { ActiveSession, Participant } from "../src/protocol/index.js";
import {
  createRoom,
  endActiveSession,
  readMessages,
  readRoomState,
  roomPaths,
  startActiveSession,
  writeParticipants,
  ActiveSessionExistsError
} from "../src/storage/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
import { WaitHub } from "../src/server/wait.js";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";

// ---- shared helpers ----

function participant(alias: string, kind: "agent" | "human", isHost: boolean, token: string): Participant {
  return {
    alias,
    kind,
    location: "local",
    install: isHost ? "host" : "lite",
    attention: "manual",
    is_host: isHost,
    token_hash: participantTokenHash(token),
    joinedAt: "2026-06-21T00:00:00.000Z",
    lastSeenAt: "2026-06-21T00:00:00.000Z"
  };
}

async function startFixture(): Promise<{
  root: string;
  roomId: string;
  baseUrl: string;
  hostToken: string;
  agentToken: string;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-session-test-"));
  const roomId = `room-${Math.random().toString(36).slice(2, 10)}`;
  const hostToken = `host-${roomId}`;
  const agentToken = `agent-${roomId}`;
  await createRoom({ root, roomId, hostAlias: "host", briefBody: "Session boundary." });
  await writeParticipants(root, roomId, [
    participant("host", "human", true, hostToken),
    participant("agent", "agent", false, agentToken)
  ]);
  const server = createRoomHttpServer({
    root,
    roomId,
    baseUrl: "http://127.0.0.1:0",
    waitHoldMs: 2_000
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    root,
    roomId,
    baseUrl: `http://127.0.0.1:${address.port}`,
    hostToken,
    agentToken,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  };
}

async function jsonFetch(
  fixture: { baseUrl: string },
  method: string,
  pathName: string,
  token: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${fixture.baseUrl}${pathName}`, init);
  return { status: response.status, body: await response.json() };
}

// ---- server tests ----

test("host starts an active session for #general and /status reflects it, then idle after end", async () => {
  const fixture = await startFixture();
  try {
    const start = await jsonFetch(fixture, "POST", "/session", fixture.hostToken, {
      action: "start",
      channel: "general",
      expected_duration_m: 30,
      requested_mode: "agents-foreground"
    });
    assert.equal(start.status, 201);
    const session = start.body.active_session as ActiveSession;
    assert.equal(session.channel_id, "general");
    assert.equal(session.expected_duration_m, 30);
    assert.equal(session.requested_mode, "agents-foreground");
    assert.equal(session.started_by, "host");
    assert.equal(session.ended_at, undefined);

    // Start appends a system message (the wake path).
    const afterStart = await readMessages(fixture.root, fixture.roomId);
    assert.equal(
      afterStart.some((m) => m.type === "system" && /active chat session started in #general/i.test(m.text)),
      true
    );

    // /status shows the session while active.
    const active = await jsonFetch(fixture, "GET", "/status", fixture.agentToken);
    assert.equal(active.status, 200);
    assert.equal(active.body.active_session.channel_id, "general");

    const end = await jsonFetch(fixture, "POST", "/session", fixture.hostToken, { action: "end" });
    assert.equal(end.status, 200);
    assert.equal((end.body.active_session as ActiveSession).channel_id, "general");
    assert.equal(typeof (end.body.active_session as ActiveSession).ended_at, "string");

    // End appends a system message and returns to idle.
    const afterEnd = await readMessages(fixture.root, fixture.roomId);
    assert.equal(
      afterEnd.some((m) => m.type === "system" && /active chat session ended in #general/i.test(m.text)),
      true
    );
    const idle = await jsonFetch(fixture, "GET", "/status", fixture.hostToken);
    assert.equal(idle.body.active_session, undefined);
  } finally {
    await fixture.close();
  }
});

test("non-host is 403, second concurrent start is 409, end without a session is 409, non-general is 400", async () => {
  const fixture = await startFixture();
  try {
    const forbidden = await jsonFetch(fixture, "POST", "/session", fixture.agentToken, {
      action: "start",
      channel: "general",
      expected_duration_m: 30
    });
    assert.equal(forbidden.status, 403);

    const endIdle = await jsonFetch(fixture, "POST", "/session", fixture.hostToken, { action: "end" });
    assert.equal(endIdle.status, 409);
    assert.equal(endIdle.body.error, "no_active_session");

    const first = await jsonFetch(fixture, "POST", "/session", fixture.hostToken, {
      action: "start",
      channel: "general",
      expected_duration_m: 30
    });
    assert.equal(first.status, 201);

    const second = await jsonFetch(fixture, "POST", "/session", fixture.hostToken, {
      action: "start",
      channel: "general",
      expected_duration_m: 30
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "session_active");

    const badChannel = await jsonFetch(fixture, "POST", "/session", fixture.hostToken, {
      action: "start",
      channel: "design-chat",
      expected_duration_m: 30
    });
    assert.equal(badChannel.status, 400);
    assert.equal(badChannel.body.error, "unsupported_channel");
  } finally {
    await fixture.close();
  }
});

test("starting a session releases a pending /wait", async () => {
  const fixture = await startFixture();
  try {
    const before = await jsonFetch(fixture, "GET", "/messages?since_id=0", fixture.agentToken);
    const sinceId = before.body.next_since_id as number;
    const waitPromise = fetch(
      `${fixture.baseUrl}/wait?participant=agent&since_id=${sinceId}`,
      { headers: { Authorization: `Bearer ${fixture.agentToken}` } }
    ).then((r) => r.json() as Promise<{ messages: { type: string; text: string }[] }>);

    await jsonFetch(fixture, "POST", "/session", fixture.hostToken, {
      action: "start",
      channel: "general",
      expected_duration_m: 15
    });

    const waitResult = await waitPromise;
    assert.equal(
      waitResult.messages.some((m) => m.type === "system" && /active chat session started/i.test(m.text)),
      true
    );
  } finally {
    await fixture.close();
  }
});

test("room close clears the active session", async () => {
  const fixture = await startFixture();
  try {
    await jsonFetch(fixture, "POST", "/session", fixture.hostToken, {
      action: "start",
      channel: "general",
      expected_duration_m: 30
    });
    const closed = await jsonFetch(fixture, "POST", "/close", fixture.hostToken);
    assert.equal(closed.status, 200);
    const state = await readRoomState(roomPaths(fixture.root, fixture.roomId));
    assert.equal(state.active_session, undefined);
  } finally {
    await fixture.close();
  }
});

// ---- storage tests ----

test("startActiveSession persists on RoomState and rejects a concurrent start", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-session-store-"));
  const roomId = "store-room";
  await createRoom({ root, roomId, hostAlias: "host" });

  const session = await startActiveSession({
    root,
    roomId,
    channelId: "general",
    startedBy: "host",
    expectedDurationM: 45
  });
  assert.equal(session.expected_duration_m, 45);
  const persisted = await readRoomState(roomPaths(root, roomId));
  assert.equal(persisted.active_session?.channel_id, "general");

  await assert.rejects(
    () => startActiveSession({ root, roomId, channelId: "general", startedBy: "host", expectedDurationM: 10 }),
    ActiveSessionExistsError
  );

  const ended = await endActiveSession({ root, roomId });
  assert.equal(ended?.channel_id, "general");
  assert.equal(typeof ended?.ended_at, "string");
  const afterEnd = await readRoomState(roomPaths(root, roomId));
  assert.equal(afterEnd.active_session, undefined);
  // Ending when idle returns null (server maps this to 409).
  assert.equal(await endActiveSession({ root, roomId }), null);
});

// ---- CLI tests (direct path, no server) ----

class Capture extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    cb();
  }
  json<T>(): T {
    return JSON.parse(this.chunks.join("")) as T;
  }
}

test("room session start|end CLI persists the session, appends system messages, and clears on end", async () => {
  const stdout = new Capture();
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "agentgather-session-cli-")),
    stdout,
    stderr: new Capture()
  };
  await runRoomCommand(["start", "cli-session", "--alias", "operator", "--json"], context);

  stdout.chunks = [];
  await runRoomCommand(["session", "start", "--duration-m", "20", "--json"], context);
  const started = stdout.json<{ ok: true; active_session: ActiveSession }>();
  assert.equal(started.active_session.channel_id, "general");
  assert.equal(started.active_session.expected_duration_m, 20);
  assert.equal(started.active_session.started_by, "operator");

  const state = await readRoomState(roomPaths(context.home, "cli-session"));
  assert.equal(state.active_session?.channel_id, "general");
  const messages = await readMessages(context.home, "cli-session");
  assert.equal(messages.some((m) => m.type === "system" && /active chat session started/i.test(m.text)), true);

  stdout.chunks = [];
  await runRoomCommand(["session", "end", "--json"], context);
  const ended = stdout.json<{ ok: true; active_session: ActiveSession }>();
  assert.equal(typeof ended.active_session.ended_at, "string");
  const idle = await readRoomState(roomPaths(context.home, "cli-session"));
  assert.equal(idle.active_session, undefined);

  await assert.rejects(() => runRoomCommand(["session", "start", "--duration-m", "0", "--json"], context));
  await assert.rejects(() => runRoomCommand(["session", "start", "--channel", "design-chat", "--json"], context));
});
