import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRoom,
  readMessages,
  writeParticipants
} from "../src/storage/index.js";
import type { Participant } from "../src/protocol/index.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-server-test-"));
}

async function startFixture(): Promise<{
  root: string;
  roomId: string;
  baseUrl: string;
  close: () => Promise<void>;
  hostToken: string;
  agentToken: string;
}> {
  const root = await makeRoot();
  const roomId = `room-${Math.random().toString(36).slice(2, 10)}`;
  const hostToken = `host-${roomId}`;
  const agentToken = `agent-${roomId}`;
  await createRoom({
    root,
    roomId,
    hostAlias: "host",
    briefBody: "Review the HTTP core."
  });
  await writeParticipants(root, roomId, [
    participant("host", "human", true, hostToken),
    participant("agent", "agent", false, agentToken)
  ]);

  const server = createRoomHttpServer({
    root,
    roomId,
    baseUrl: "http://127.0.0.1:0",
    rateLimitPerMinute: 1_000
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    root,
    roomId,
    baseUrl,
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

test("GET /watch returns a 404 that points clients to /wait", async () => {
  const fixture = await startFixture();
  try {
    const response = await fetch(`${fixture.baseUrl}/watch`);
    const body = (await response.json()) as { message: string };
    assert.equal(response.status, 404);
    assert.match(body.message, /\/wait/);
  } finally {
    await fixture.close();
  }
});

test("HTTP core exposes every non-wait endpoint", async () => {
  const fixture = await startFixture();
  try {
    const browser = await fetch(`${fixture.baseUrl}/`);
    assert.equal(browser.status, 200);
    assert.match(await browser.text(), /Agent Gather Room/);

    const brief = await jsonFetch(fixture, "GET", "/brief", fixture.agentToken);
    assert.equal(brief.status, 200);
    assert.equal(brief.body.brief.body, "Review the HTTP core.");

    const updatedBrief = await jsonFetch(fixture, "POST", "/brief", fixture.hostToken, {
      body: "Updated room brief"
    });
    assert.equal(updatedBrief.status, 200);
    assert.equal(updatedBrief.body.brief.brief_version, 2);

    const card = await fetch(`${fixture.baseUrl}/card?participant=agent&token=${fixture.agentToken}`);
    assert.equal(card.status, 200);
    assert.match(card.headers.get("content-type") ?? "", /text\/plain/);
    const agentCard = await card.text();
    assert.match(agentCard, /# Agent Gather Attend Card: agent/);
    assert.match(agentCard, /Updated room brief/);
    assert.match(agentCard, /\/wait\?participant=agent&since_id=0/);

    const humanCard = await fetch(`${fixture.baseUrl}/card?participant=host&token=${fixture.hostToken}`);
    assert.equal(humanCard.status, 200);
    const humanCardText = await humanCard.text();
    assert.match(humanCardText, /# Agent Gather Human Invite: host/);
    assert.match(humanCardText, /#token=host-/);
    assert.doesNotMatch(humanCardText, /curl -s/);
    assert.doesNotMatch(humanCardText, /\/wait/);

    const join = await jsonFetch(fixture, "POST", "/join", fixture.agentToken);
    assert.equal(join.status, 200);

    const profile = await jsonFetch(fixture, "POST", "/profile", fixture.hostToken, {
      display_name: "Operator"
    });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.participant.display_name, "Operator");

    const duplicateProfile = await jsonFetch(fixture, "POST", "/profile", fixture.agentToken, {
      display_name: "operator"
    });
    assert.equal(duplicateProfile.status, 409);
    assert.equal(duplicateProfile.body.error, "display_name_taken");

    const invalidProfile = await jsonFetch(fixture, "POST", "/profile", fixture.agentToken, {
      display_name: ""
    });
    assert.equal(invalidProfile.status, 400);
    assert.equal(invalidProfile.body.error, "invalid_display_name");

    const sent = await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, {
      text: "@host hello",
      client_msg_id: "client-1"
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.message.from, "agent");
    assert.deepEqual(sent.body.message.mentions, ["host"]);

    const messages = await jsonFetch(fixture, "GET", "/messages?since_id=0", fixture.hostToken);
    assert.equal(messages.status, 200);
    assert.equal(messages.body.messages.some((message: { text: string }) => message.text === "@host hello"), true);

    const status = await jsonFetch(fixture, "GET", "/status", fixture.hostToken);
    assert.equal(status.status, 200);
    assert.equal(status.body.brief_version, 2);
    assert.equal(status.body.attendance_policy, "manual-ok");
    assert.equal(status.body.participants.some((entry: { token_hash?: string }) => entry.token_hash), false);
    assert.equal(status.body.stale_after_ms, 90_000);
    assert.equal(
      status.body.participants.find((entry: { alias: string }) => entry.alias === "agent").attendance_required,
      false
    );

    const attendance = await jsonFetch(fixture, "POST", "/attendance", fixture.hostToken, {
      policy: "agents-foreground"
    });
    assert.equal(attendance.status, 200);
    assert.equal(attendance.body.attendance_policy, "agents-foreground");

    const updatedStatus = await jsonFetch(fixture, "GET", "/status", fixture.hostToken);
    assert.equal(updatedStatus.body.attendance_policy, "agents-foreground");
    const requiredAgent = updatedStatus.body.participants.find((entry: { alias: string }) => entry.alias === "agent");
    assert.equal(requiredAgent.attendance_required, true);
    assert.equal(requiredAgent.attendance_state, "attending");

    await writeParticipants(fixture.root, fixture.roomId, [
      participant("host", "human", true, fixture.hostToken),
      participant("agent", "agent", false, fixture.agentToken)
    ]);
    const notAttendingStatus = await jsonFetch(fixture, "GET", "/status", fixture.hostToken);
    const notAttendingAgent = notAttendingStatus.body.participants.find(
      (entry: { alias: string }) => entry.alias === "agent"
    );
    assert.equal(notAttendingAgent.attendance_required, true);
    assert.equal(notAttendingAgent.attendance_state, "not_attending");

    await writeParticipants(fixture.root, fixture.roomId, [
      participant("host", "human", true, fixture.hostToken),
      {
        ...participant("agent", "agent", false, fixture.agentToken),
        attention: "attending",
        lastSeenAt: new Date(Date.now() - 120_000).toISOString()
      }
    ]);
    const staleStatus = await jsonFetch(fixture, "GET", "/status", fixture.hostToken);
    const staleAgent = staleStatus.body.participants.find((entry: { alias: string }) => entry.alias === "agent");
    assert.equal(staleAgent.attendance_required, true);
    assert.equal(staleAgent.attendance_state, "stale");
    assert.equal(staleAgent.last_seen_age_ms >= 90_000, true);

    const leave = await jsonFetch(fixture, "POST", "/leave", fixture.agentToken);
    assert.equal(leave.status, 200);

    const close = await jsonFetch(fixture, "POST", "/close", fixture.hostToken);
    assert.equal(close.status, 200);
    assert.equal(close.body.room_status, "closed");

    const afterClose = await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, {
      text: "too late"
    });
    assert.equal(afterClose.status, 403);
    assert.equal(afterClose.body.error, "room_closed");

    const lifecycleMessages = await readMessages(fixture.root, fixture.roomId);
    assert.equal(
      ["Room brief updated to v2", "agent joined", "agent left", "room closed"].every((text) =>
        lifecycleMessages.some((message) => message.type === "system" && message.text === text)
      ),
      true
    );
  } finally {
    await fixture.close();
  }
});

test("auth binds sender identity and rejects client-supplied from", async () => {
  const fixture = await startFixture();
  try {
    const sent = await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, {
      from: "host",
      text: "spoof attempt"
    });

    assert.equal(sent.status, 201);
    assert.equal(sent.body.message.from, "agent");
  } finally {
    await fixture.close();
  }
});

test("client_msg_id idempotency returns the original message", async () => {
  const fixture = await startFixture();
  try {
    const first = await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, {
      text: "first body",
      client_msg_id: "same-id"
    });
    const second = await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, {
      text: "different body",
      client_msg_id: "same-id"
    });
    const log = await readMessages(fixture.root, fixture.roomId);

    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.idempotent, true);
    assert.equal(second.body.message.text, "first body");
    assert.equal(log.filter((message) => message.client_msg_id === "same-id").length, 1);

    const [raceOne, raceTwo] = await Promise.all([
      jsonFetch(fixture, "POST", "/messages", fixture.agentToken, {
        text: "race one",
        client_msg_id: "race-id"
      }),
      jsonFetch(fixture, "POST", "/messages", fixture.agentToken, {
        text: "race two",
        client_msg_id: "race-id"
      })
    ]);
    const raceLog = await readMessages(fixture.root, fixture.roomId);
    assert.equal([raceOne.status, raceTwo.status].sort().join(","), "200,201");
    assert.equal(raceLog.filter((message) => message.client_msg_id === "race-id").length, 1);
  } finally {
    await fixture.close();
  }
});

test("security guards reject oversized brief, cross-origin write, and non-localhost host", async () => {
  const fixture = await startFixture();
  try {
    const oversized = await jsonFetch(fixture, "POST", "/brief", fixture.hostToken, {
      body: "x".repeat(16_001)
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.ok, false);

    const csrf = await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, { text: "bad" }, {
      Origin: "http://evil.example"
    });
    assert.equal(csrf.status, 403);
    assert.equal(csrf.body.error, "bad_origin");

    const badReferer = await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, { text: "bad" }, {
      Referer: "not a url"
    });
    assert.equal(badReferer.status, 403);
    assert.equal(badReferer.body.error, "bad_referer");

    const queryTokenRead = await fetch(`${fixture.baseUrl}/brief?token=${fixture.agentToken}`);
    assert.equal(queryTokenRead.status, 401);

    const remote = await rawJsonRequest(fixture.baseUrl, "/status", {
      Authorization: `Bearer ${fixture.hostToken}`,
      Host: "example.com"
    });
    assert.equal(remote.status, 403);
    assert.equal(remote.body.error, "insecure_remote");
  } finally {
    await fixture.close();
  }
});

test("loop guard blocks repeated agent messages and resets on human message", async () => {
  const fixture = await startFixture();
  try {
    let blockedStatus = 0;
    for (let index = 0; index < 32; index += 1) {
      const response = await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, {
        text: `agent ${index}`
      });
      blockedStatus = response.status;
      if (response.status === 429) break;
    }
    assert.equal(blockedStatus, 429);
    const guardedLog = await readMessages(fixture.root, fixture.roomId);
    assert.equal(guardedLog.filter((message) => message.text.startsWith("agent ")).length, 30);

    const human = await jsonFetch(fixture, "POST", "/messages", fixture.hostToken, { text: "reset" });
    assert.equal(human.status, 201);
    const agent = await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, { text: "after reset" });
    assert.equal(agent.status, 201);
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

async function rawJsonRequest(
  baseUrl: string,
  pathName: string,
  headers: Record<string, string>
): Promise<{ status: number; body: any }> {
  const url = new URL(pathName, baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function jsonFetch(
  fixture: { baseUrl: string },
  method: string,
  pathName: string,
  token: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers
    }
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${fixture.baseUrl}${pathName}`, init);
  return { status: response.status, body: await response.json() };
}
