import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Participant } from "../src/protocol/index.js";
import { createRoom, readMessages, writeParticipants } from "../src/storage/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
import { WaitHub } from "../src/server/wait.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-wait-test-"));
}

async function startWaitFixture(
  options: { expiresAt?: Date; removedAgent?: boolean; waitHoldMs?: number } = {}
): Promise<{
  root: string;
  roomId: string;
  baseUrl: string;
  hostToken: string;
  agentToken: string;
  close: () => Promise<void>;
}> {
  const root = await makeRoot();
  const roomId = `wait-${Math.random().toString(36).slice(2, 10)}`;
  const hostToken = `host-${roomId}`;
  const agentToken = `agent-${roomId}`;
  const createOptions = {
    root,
    roomId,
    hostAlias: "host"
  };
  await createRoom(
    options.expiresAt === undefined ? createOptions : { ...createOptions, expiresAt: options.expiresAt }
  );
  await writeParticipants(root, roomId, [
    participant("host", "human", true, hostToken),
    {
      ...participant("agent", "agent", false, agentToken),
      ...(options.removedAgent ? { removed_at: "2026-06-21T00:00:00.000Z" } : {})
    }
  ]);
  const waitHub = new WaitHub();
  const server = createRoomHttpServer({
    root,
    roomId,
    baseUrl: "http://127.0.0.1:0",
    // Default hold is short so heartbeat tests don't dawdle. Release tests that
    // race a held /wait against a slower write (close/append) pass a longer hold
    // so the wake-up notify reliably lands before the hold times out — otherwise
    // a loaded CI runner can time the hold out before the write commits and the
    // snapshot reads stale-open state (the #127 flake).
    waitHoldMs: options.waitHoldMs ?? 100,
    waitHub
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

test("/wait returns existing messages immediately with exclusive since_id", async () => {
  const fixture = await startWaitFixture();
  try {
    await jsonFetch(fixture, "POST", "/messages", fixture.hostToken, { text: "@agent first" });
    const second = await jsonFetch(fixture, "POST", "/messages", fixture.hostToken, { text: "@agent second" });
    const waited = await jsonFetch(
      fixture,
      "GET",
      `/wait?participant=agent&since_id=${second.body.message.id - 1}`,
      fixture.agentToken
    );

    assert.equal(waited.status, 200);
    assert.equal(waited.body.heartbeat, false);
    assert.equal(waited.body.messages.length, 1);
    assert.equal(waited.body.messages[0].text, "@agent second");
    assert.equal(waited.body.mentioned, true);
    assert.equal(waited.body.next_since_id, second.body.message.id);
  } finally {
    await fixture.close();
  }
});

test("/wait heartbeat returns keep_waiting and next_cmd", async () => {
  const fixture = await startWaitFixture();
  try {
    const waited = await jsonFetch(fixture, "GET", "/wait?participant=agent&since_id=0", fixture.agentToken);

    assert.equal(waited.status, 200);
    assert.equal(waited.body.heartbeat, true);
    assert.equal(waited.body.keep_waiting, true);
    assert.equal(String(waited.body.next_cmd).includes("/wait?participant=agent&since_id=0"), true);
    assert.equal(String(waited.body.next_cmd).includes("//wait?participant="), false);
  } finally {
    await fixture.close();
  }
});

test("/wait held request releases when a new message arrives", async () => {
  const fixture = await startWaitFixture({ waitHoldMs: 1_000 });
  try {
    const waitPromise = jsonFetch(fixture, "GET", "/wait?participant=agent&since_id=0", fixture.agentToken);
    setTimeout(() => {
      void jsonFetch(fixture, "POST", "/messages", fixture.hostToken, { text: "@agent wake" });
    }, 5);
    const waited = await waitPromise;

    assert.equal(waited.status, 200);
    assert.equal(waited.body.heartbeat, false);
    assert.equal(waited.body.messages[0].text, "@agent wake");
    assert.equal(waited.body.keep_waiting, false);
  } finally {
    await fixture.close();
  }
});

test("/wait releases on room close", async () => {
  const fixture = await startWaitFixture({ waitHoldMs: 1_000 });
  try {
    const waitPromise = jsonFetch(fixture, "GET", "/wait?participant=agent&since_id=0", fixture.agentToken);
    setTimeout(() => {
      void jsonFetch(fixture, "POST", "/close", fixture.hostToken);
    }, 5);
    const waited = await waitPromise;

    assert.equal(waited.status, 200);
    assert.equal(waited.body.room_status, "closed");
    assert.equal(waited.body.keep_waiting, false);
    assert.equal(waited.body.next_cmd, null);
  } finally {
    await fixture.close();
  }
});

test("/wait enforces TTL auto-close", async () => {
  const fixture = await startWaitFixture({ expiresAt: new Date("2000-01-01T00:00:00.000Z") });
  try {
    const waited = await jsonFetch(fixture, "GET", "/wait?participant=agent&since_id=0", fixture.agentToken);
    const log = await readMessages(fixture.root, fixture.roomId);

    assert.equal(waited.status, 200);
    assert.equal(waited.body.room_status, "closed");
    assert.equal(log.some((message) => message.text === "room closed by ttl"), true);
  } finally {
    await fixture.close();
  }
});

test("expired rooms reject message writes and emit TTL close once", async () => {
  const fixture = await startWaitFixture({ expiresAt: new Date("2000-01-01T00:00:00.000Z") });
  try {
    const write = await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, { text: "expired" });
    const waited = await jsonFetch(fixture, "GET", "/wait?participant=agent&since_id=0", fixture.agentToken);
    const log = await readMessages(fixture.root, fixture.roomId);

    assert.equal(write.status, 403);
    assert.equal(write.body.error, "room_closed");
    assert.equal(waited.body.room_status, "closed");
    assert.equal(log.filter((message) => message.text === "room closed by ttl").length, 1);
  } finally {
    await fixture.close();
  }
});

test("/wait returns a terminal removed-participant response", async () => {
  const fixture = await startWaitFixture({
    removedAgent: true,
    expiresAt: new Date("2000-01-01T00:00:00.000Z")
  });
  try {
    const waited = await jsonFetch(fixture, "GET", "/wait?participant=agent&since_id=0", fixture.agentToken);

    assert.equal(waited.status, 200);
    assert.equal(waited.body.room_status, "closed");
    assert.equal(waited.body.participant_status, "removed");
    assert.equal(waited.body.keep_waiting, false);
  } finally {
    await fixture.close();
  }
});

test("/wait rejects query-token auth and participant mismatch", async () => {
  const fixture = await startWaitFixture();
  try {
    const queryToken = await fetch(`${fixture.baseUrl}/wait?participant=agent&since_id=0&token=${fixture.agentToken}`);
    assert.equal(queryToken.status, 401);

    const mismatch = await jsonFetch(fixture, "GET", "/wait?participant=host&since_id=0", fixture.agentToken);
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.body.error, "participant_mismatch");
  } finally {
    await fixture.close();
  }
});

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

async function jsonFetch(
  fixture: { baseUrl: string },
  method: string,
  pathName: string,
  token: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${fixture.baseUrl}${pathName}`, init);
  return { status: response.status, body: await response.json() };
}
