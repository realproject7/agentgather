import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  closeRoom,
  createRoom,
  readMessages,
  writeParticipants
} from "../src/storage/index.js";
import type { Participant } from "../src/protocol/index.js";
import { closeServer } from "./support/close-server.js";
import {
  createRoomHttpServer,
  participantTokenHash,
  rateBucketCount,
  clearRateBuckets,
  __enforceRateLimit
} from "../src/server/index.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-server-test-"));
}

async function startFixture(options: { waitHoldMs?: number; expiresAt?: Date } = {}): Promise<{
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
    briefBody: "Review the HTTP core.",
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt })
  });
  await writeParticipants(root, roomId, [
    participant("host", "human", true, hostToken),
    participant("agent", "agent", false, agentToken)
  ]);

  const server = createRoomHttpServer({
    root,
    roomId,
    baseUrl: "http://127.0.0.1:0",
    rateLimitPerMinute: 1_000,
    // #249's expiry test holds a /wait across the real 30s delay, which needs a
    // hold window longer than the 25s default.
    ...(options.waitHoldMs === undefined ? {} : { waitHoldMs: options.waitHoldMs })
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
      closeServer(server)
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

test("GET /messages enforces the #general channel boundary (V2 #167)", async () => {
  const fixture = await startFixture();
  try {
    await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, { text: "hello general" });

    // no `channel` param → unchanged room-wide log
    const noChannel = await jsonFetch(fixture, "GET", "/messages?since_id=0", fixture.hostToken);
    assert.equal(noChannel.status, 200);
    assert.equal(noChannel.body.messages.some((m: { text: string }) => m.text === "hello general"), true);

    // channel=general (the default chat channel) → same room-wide log
    const general = await jsonFetch(fixture, "GET", "/messages?channel=general&since_id=0", fixture.hostToken);
    assert.equal(general.status, 200);
    assert.equal(general.body.messages.some((m: { text: string }) => m.text === "hello general"), true);

    // any other chat channel → a clear 400, NOT a silent room-wide log
    const other = await jsonFetch(fixture, "GET", "/messages?channel=ops-chat-test&since_id=0", fixture.hostToken);
    assert.equal(other.status, 400);
    assert.equal(other.body.error, "unsupported_channel");
    assert.equal("messages" in other.body, false);
  } finally {
    await fixture.close();
  }
});

test("a concurrent second session joining an actively-attended alias gets a soft, privacy-safe warning (#163)", async () => {
  const fixture = await startFixture();
  try {
    // First session joins: nothing was actively attended, so no warning.
    const first = await jsonFetch(fixture, "POST", "/join", fixture.agentToken, { session_id: "session-A" });
    assert.equal(first.status, 200);
    assert.equal(first.body.warning, undefined);

    // A *different* session joins the same token while the first is still attending
    // and fresh — soft warning, but still a 200 (the token is the auth; never blocked).
    const second = await jsonFetch(fixture, "POST", "/join", fixture.agentToken, { session_id: "session-B" });
    assert.equal(second.status, 200);
    assert.equal(second.body.ok, true);
    assert.equal(second.body.participant, "agent");
    assert.match(second.body.warning, /already .*attended/i);
    // Privacy: the warning leaks no token, no session markers, and no counts.
    assert.ok(!second.body.warning.includes(fixture.agentToken));
    assert.ok(!second.body.warning.includes("session-A"));
    assert.ok(!second.body.warning.includes("session-B"));
    assert.ok(!/\btoken\b/i.test(second.body.warning));
  } finally {
    await fixture.close();
  }
});

test("a markerless concurrent join is still flagged; the same session_id resuming is not (#163)", async () => {
  const fixture = await startFixture();
  try {
    // Legacy clients send no session_id: fall back to attendance_state + last-seen.
    assert.equal((await jsonFetch(fixture, "POST", "/join", fixture.agentToken)).body.warning, undefined);
    const markerless = await jsonFetch(fixture, "POST", "/join", fixture.agentToken);
    assert.match(markerless.body.warning, /already .*attended/i);

    // The same session marker resuming while still fresh is a reconnect, not a duplicate.
    const markedFirst = await jsonFetch(fixture, "POST", "/join", fixture.hostToken, { session_id: "host-sess" });
    assert.equal(markedFirst.body.warning, undefined);
    const markedResume = await jsonFetch(fixture, "POST", "/join", fixture.hostToken, { session_id: "host-sess" });
    assert.equal(markedResume.body.warning, undefined);
  } finally {
    await fixture.close();
  }
});

test("a reconnect after leaving or going stale rejoins with no spurious warning (#163)", async () => {
  const fixture = await startFixture();
  try {
    // Join, then leave (attention -> away) and rejoin: not actively attended -> no warning.
    await jsonFetch(fixture, "POST", "/join", fixture.agentToken, { session_id: "s1" });
    await jsonFetch(fixture, "POST", "/leave", fixture.agentToken);
    const afterLeave = await jsonFetch(fixture, "POST", "/join", fixture.agentToken, { session_id: "s2" });
    assert.equal(afterLeave.status, 200);
    assert.equal(afterLeave.body.warning, undefined);

    // Simulate the prior session going stale (last seen beyond the 90s window) while
    // still marked attending; a fresh session rejoining is a reconnect, not a dupe.
    await writeParticipants(fixture.root, fixture.roomId, [
      participant("host", "human", true, fixture.hostToken),
      {
        ...participant("agent", "agent", false, fixture.agentToken),
        attention: "attending",
        lastSeenAt: new Date(Date.now() - 120_000).toISOString()
      }
    ]);
    const afterStale = await jsonFetch(fixture, "POST", "/join", fixture.agentToken, { session_id: "s3" });
    assert.equal(afterStale.status, 200);
    assert.equal(afterStale.body.warning, undefined);
  } finally {
    await fixture.close();
  }
});

test("an invalid session_id is rejected before any join is recorded (#163)", async () => {
  const fixture = await startFixture();
  try {
    const empty = await jsonFetch(fixture, "POST", "/join", fixture.agentToken, { session_id: "" });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, "invalid_session_id");
    const tooLong = await jsonFetch(fixture, "POST", "/join", fixture.agentToken, { session_id: "x".repeat(201) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error, "invalid_session_id");
  } finally {
    await fixture.close();
  }
});

test("the session_id marker is server-only and never exposed through the /status roster (#163)", async () => {
  const fixture = await startFixture();
  try {
    // The agent joins with an opaque session marker; a duplicate join yields the warning.
    await jsonFetch(fixture, "POST", "/join", fixture.agentToken, { session_id: "secret-marker-A" });
    const dupe = await jsonFetch(fixture, "POST", "/join", fixture.agentToken, { session_id: "secret-marker-B" });
    assert.match(dupe.body.warning, /already .*attended/i);
    assert.ok(!dupe.body.warning.includes("secret-marker-A"));

    // Any participant polling /status must NOT see other clients' session markers.
    const status = await jsonFetch(fixture, "GET", "/status", fixture.hostToken);
    assert.equal(status.status, 200);
    for (const roster of status.body.participants as Array<Record<string, unknown>>) {
      assert.equal("session_id" in roster, false);
      assert.equal("token_hash" in roster, false);
    }
    // The raw serialized response carries no marker anywhere either.
    assert.ok(!JSON.stringify(status.body).includes("secret-marker"));
  } finally {
    await fixture.close();
  }
});

test("a non-message write endpoint is rate-limited with the shared 429 shape (#188)", async () => {
  const fixture = await startFixture();
  try {
    // /brief's budget is 20/min per room:alias; the 21st host edit in the window is
    // rejected with the same rate_limited/429 shape as /messages.
    let last: { status: number; body: any } = { status: 0, body: {} };
    for (let i = 0; i < 21; i += 1) {
      last = await jsonFetch(fixture, "POST", "/brief", fixture.hostToken, { body: `edit ${i}` });
    }
    assert.equal(last.status, 429);
    assert.equal(last.body.error, "rate_limited");
    assert.match(last.body.message, /rate limit/i);

    // A different endpoint keeps its own budget — the /brief limit doesn't spill over.
    const attendance = await jsonFetch(fixture, "POST", "/attendance", fixture.hostToken, { policy: "manual-ok" });
    assert.equal(attendance.status, 200);
  } finally {
    await fixture.close();
  }
});

test("the rate-limit bucket map stays bounded as aliases churn (expired windows reclaimed) (#188)", async () => {
  clearRateBuckets();
  const base = 1_000_000;
  // Many distinct aliases each touch once inside the same window: buckets accumulate.
  for (let i = 0; i < 500; i += 1) {
    __enforceRateLimit(`room:alias-${i}:join`, 60, base);
  }
  assert.equal(rateBucketCount(), 500);
  // A later touch after the 60s window elapses prunes every expired bucket on touch,
  // so the map cannot grow without bound over the life of the process.
  __enforceRateLimit("room:fresh:join", 60, base + 60_001);
  assert.equal(rateBucketCount(), 1);
  clearRateBuckets();
});

test("every room-server response carries the CSP + browser-hardening headers (#181)", async () => {
  const fixture = await startFixture();
  try {
    // HTML shell: strict script-src plus object-src/base-uri/frame-ancestors none.
    const html = await fetch(`${fixture.baseUrl}/`);
    assert.equal(html.status, 200);
    const csp = html.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    // No 'unsafe-inline' — the browser assets carry no inline script, so the CSP
    // stays strict; a regression that injected one would be blocked, not allowed.
    assert.equal(/unsafe-inline/.test(csp), false);
    assert.equal(html.headers.get("x-content-type-options"), "nosniff");
    assert.equal(html.headers.get("referrer-policy"), "no-referrer");

    // JSON/API responses carry them too (harmless for CLI/API; nosniff still helps).
    const status = await fetch(`${fixture.baseUrl}/status`, {
      headers: { Authorization: `Bearer ${fixture.hostToken}` }
    });
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("x-content-type-options"), "nosniff");
    assert.match(status.headers.get("content-security-policy") ?? "", /script-src 'self'/);

    // Even error responses are hardened (they render as JSON but stay covered).
    const notFound = await fetch(`${fixture.baseUrl}/does-not-exist`);
    assert.equal(notFound.status, 404);
    assert.equal(notFound.headers.get("referrer-policy"), "no-referrer");
  } finally {
    await fixture.close();
  }
});

test("host-only mutation routes reject a non-host caller with 403 host_required, even invoked directly (#212)", async () => {
  const fixture = await startFixture();
  try {
    // The agent participant is a real, authenticated caller (valid bearer token)
    // but is_host is false. Hitting the mutation routes directly — as a manually
    // forged request would — must be refused server-side, not merely hidden in UI.
    const close = await jsonFetch(fixture, "POST", "/close", fixture.agentToken);
    assert.equal(close.status, 403);
    assert.equal(close.body.error, "host_required");

    const brief = await jsonFetch(fixture, "POST", "/brief", fixture.agentToken, { body: "hijack" });
    assert.equal(brief.status, 403);
    assert.equal(brief.body.error, "host_required");

    const attendance = await jsonFetch(fixture, "POST", "/attendance", fixture.agentToken, { policy: "manual-ok" });
    assert.equal(attendance.status, 403);
    assert.equal(attendance.body.error, "host_required");

    // The session lifecycle route is host-only too (a valid start body still can't
    // get past the authorization gate for a non-host).
    const session = await jsonFetch(fixture, "POST", "/session", fixture.agentToken, {
      action: "start",
      expected_duration_m: 20
    });
    assert.equal(session.status, 403);
    assert.equal(session.body.error, "host_required");

    // The gate is specific to host-only actions: a participant-safe write (posting
    // a message) still succeeds for the same non-host token, so this is authorization
    // scoping, not a blanket block. The room is still open (close was refused above).
    const message = await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, { text: "participant-safe write" });
    assert.equal(message.status, 201);

    // The host retains every host-owned control.
    const hostClose = await jsonFetch(fixture, "POST", "/close", fixture.hostToken);
    assert.equal(hostClose.status, 200);
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

// #249: host-opt-in automatic continue after a loop-guard pause. Default OFF —
// a room with no saved preference must behave exactly as it did before.

async function driveGuardToPause(fixture: { baseUrl: string }, token: string): Promise<number> {
  let status = 0;
  for (let index = 0; index < 32; index += 1) {
    const response = await jsonFetch(fixture, "POST", "/messages", token, { text: `agent ${index}` });
    status = response.status;
    if (status === 429) break;
  }
  return status;
}

async function loopGuardOf(fixture: { baseUrl: string }, token: string): Promise<Record<string, unknown>> {
  const status = await jsonFetch(fixture, "GET", "/status", token);
  return status.body.loop_guard as Record<string, unknown>;
}

test("the loop-guard preference is host-only and validated server-side (#249)", async () => {
  const fixture = await startFixture();
  try {
    // A non-host cannot write the preference, whatever it sends.
    const forbidden = await jsonFetch(fixture, "POST", "/loop-guard", fixture.agentToken, { enabled: true });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error, "host_required");

    // Type and bounds are enforced by the server, not the browser.
    for (const bad of [{ enabled: "yes" }, { enabled: 1 }, {}]) {
      const response = await jsonFetch(fixture, "POST", "/loop-guard", fixture.hostToken, bad);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.equal(response.body.error, "invalid_auto_continue");
    }
    for (const delay of [29, 301, 30.5, "60", null]) {
      const response = await jsonFetch(fixture, "POST", "/loop-guard", fixture.hostToken, {
        enabled: true,
        delay_s: delay
      });
      assert.equal(response.status, 400, `expected 400 for delay ${String(delay)}`);
      assert.equal(response.body.error, "invalid_auto_continue_delay");
    }

    // The bounds themselves are accepted.
    for (const delay of [30, 300]) {
      const ok = await jsonFetch(fixture, "POST", "/loop-guard", fixture.hostToken, { enabled: true, delay_s: delay });
      assert.equal(ok.status, 200);
      assert.equal((ok.body.loop_guard as { auto_continue_delay_s: number }).auto_continue_delay_s, delay);
    }
  } finally {
    await fixture.close();
  }
});

test("status exposes a token-free loop-guard projection that defaults to disabled (#249)", async () => {
  const fixture = await startFixture();
  try {
    const response = await jsonFetch(fixture, "GET", "/status", fixture.agentToken);
    const guard = response.body.loop_guard as Record<string, unknown>;
    assert.equal(guard.auto_continue_enabled, false, "a room with no saved preference reads as disabled");
    assert.equal(guard.auto_continue_delay_s, 30);
    assert.equal(guard.auto_continue_count, 0);
    assert.equal(guard.pending, false);
    assert.equal(guard.limit, 30);
    // Nothing pending, so no alias or countdown is published at all.
    assert.equal("pending_alias" in guard, false);
    assert.equal("pending_seconds_remaining" in guard, false);
    // No credential-shaped or internal value anywhere in the projection.
    const serialized = JSON.stringify(guard);
    assert.doesNotMatch(serialized, /host-|agent-|Bearer|token|#token=|\/card\?|Timeout|_idle/i);
    assert.equal(serialized.includes(fixture.root), false);
  } finally {
    await fixture.close();
  }
});

test("with auto-continue off the guard stops repeated agent posts exactly as before (#249)", async () => {
  const fixture = await startFixture();
  try {
    assert.equal(await driveGuardToPause(fixture, fixture.agentToken), 429);
    const guard = await loopGuardOf(fixture, fixture.hostToken);
    // No opt-in means no pending cycle and no continuation is ever scheduled.
    assert.equal(guard.pending, false);
    assert.equal(guard.auto_continue_count, 0);
    const log = await readMessages(fixture.root, fixture.roomId);
    assert.equal(log.filter((message) => message.text.startsWith("agent ")).length, 30);
    assert.equal(log.some((message) => message.text.includes("auto-continue")), false);
  } finally {
    await fixture.close();
  }
});

test("an enabled guard hit opens exactly one pending cycle and blocks further agent posts (#249)", async () => {
  const fixture = await startFixture();
  try {
    await jsonFetch(fixture, "POST", "/loop-guard", fixture.hostToken, { enabled: true, delay_s: 300 });
    assert.equal(await driveGuardToPause(fixture, fixture.agentToken), 429);

    const guard = await loopGuardOf(fixture, fixture.hostToken);
    assert.equal(guard.pending, true);
    assert.equal(guard.pending_alias, "agent", "only the alias whose post was rejected is retained");
    assert.ok((guard.pending_seconds_remaining as number) > 0);

    // A second agent post while pending is rejected and must NOT restart or
    // duplicate the cycle — the countdown keeps running down, never resets.
    const first = guard.pending_seconds_remaining as number;
    const blocked = await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, { text: "racing the timer" });
    assert.equal(blocked.status, 429);
    const after = await loopGuardOf(fixture, fixture.hostToken);
    assert.equal(after.pending, true);
    assert.equal(after.pending_alias, "agent");
    assert.ok((after.pending_seconds_remaining as number) <= first, "the pending cycle was restarted");

    // Nothing was written for the rejected posts.
    const log = await readMessages(fixture.root, fixture.roomId);
    assert.equal(log.some((message) => message.text === "racing the timer"), false);
  } finally {
    await fixture.close();
  }
});

test("a human post cancels a pending continuation and resets the guard (#249)", async () => {
  const fixture = await startFixture();
  try {
    await jsonFetch(fixture, "POST", "/loop-guard", fixture.hostToken, { enabled: true, delay_s: 300 });
    assert.equal(await driveGuardToPause(fixture, fixture.agentToken), 429);
    assert.equal((await loopGuardOf(fixture, fixture.hostToken)).pending, true);

    const human = await jsonFetch(fixture, "POST", "/messages", fixture.hostToken, { text: "reset" });
    assert.equal(human.status, 201);
    const guard = await loopGuardOf(fixture, fixture.hostToken);
    assert.equal(guard.pending, false, "a human post cancels the pending continuation");
    assert.equal(guard.auto_continue_count, 0, "cancelling is not a continuation");
    // The existing human-reset semantics still hold.
    const agent = await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, { text: "after reset" });
    assert.equal(agent.status, 201);
  } finally {
    await fixture.close();
  }
});

test("disabling the preference or closing the room cancels a pending continuation (#249)", async () => {
  for (const cancel of ["disable", "close"] as const) {
    const fixture = await startFixture();
    try {
      await jsonFetch(fixture, "POST", "/loop-guard", fixture.hostToken, { enabled: true, delay_s: 300 });
      assert.equal(await driveGuardToPause(fixture, fixture.agentToken), 429);
      assert.equal((await loopGuardOf(fixture, fixture.hostToken)).pending, true, `${cancel}: precondition`);

      if (cancel === "disable") {
        const off = await jsonFetch(fixture, "POST", "/loop-guard", fixture.hostToken, { enabled: false });
        assert.equal(off.status, 200);
        assert.equal((off.body.loop_guard as { pending: boolean }).pending, false);
        assert.equal((await loopGuardOf(fixture, fixture.hostToken)).pending, false);
      } else {
        const closed = await jsonFetch(fixture, "POST", "/close", fixture.hostToken);
        assert.equal(closed.status, 200);
      }

      // Whichever path cancelled it, no continuation is ever appended.
      const log = await readMessages(fixture.root, fixture.roomId);
      assert.equal(log.some((message) => message.text.includes("auto-continue approved")), false, cancel);
    } finally {
      await fixture.close();
    }
  }
});

test("the host preference survives a restart but a pending continuation never replays (#249)", async () => {
  const fixture = await startFixture();
  await jsonFetch(fixture, "POST", "/loop-guard", fixture.hostToken, { enabled: true, delay_s: 300 });
  assert.equal(await driveGuardToPause(fixture, fixture.agentToken), 429);
  assert.equal((await loopGuardOf(fixture, fixture.hostToken)).pending, true);
  await fixture.close();

  // A fresh server over the same room directory: the persisted preference is
  // still there, but the in-memory pending cycle and its timer are gone.
  const restarted = createRoomHttpServer({ root: fixture.root, roomId: fixture.roomId, baseUrl: "http://127.0.0.1:0" });
  await new Promise<void>((resolve) => {
    restarted.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = restarted.address() as AddressInfo;
    const guard = await loopGuardOf({ baseUrl: `http://127.0.0.1:${address.port}` }, fixture.hostToken);
    assert.equal(guard.auto_continue_enabled, true, "the host preference is persisted");
    assert.equal(guard.auto_continue_delay_s, 300);
    assert.equal(guard.pending, false, "no pending cycle is replayed after a restart");
    assert.equal(guard.auto_continue_count, 0, "the process-local count starts fresh");
    const log = await readMessages(fixture.root, fixture.roomId);
    assert.equal(log.some((message) => message.text.includes("auto-continue approved")), false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      restarted.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

// The real expiry, driven by the real timer. The accepted delay range starts at
// 30s and the server is the authority on it, so this test waits out the genuine
// minimum rather than reaching into the timer or adding a test-only override to
// production code. It is the one slow test in this ticket, deliberately.
test("on expiry the guard re-arms with one system-authored approval mentioning only the blocked alias (#249)", { timeout: 90_000 }, async () => {
  const fixture = await startFixture({ waitHoldMs: 50_000 });
  try {
    await jsonFetch(fixture, "POST", "/loop-guard", fixture.hostToken, { enabled: true, delay_s: 30 });
    const before = await readMessages(fixture.root, fixture.roomId);
    assert.equal(await driveGuardToPause(fixture, fixture.agentToken), 429);

    // The blocked agent is waiting in its normal /wait loop when the timer fires.
    const waitPromise = fetch(
      `${fixture.baseUrl}/wait?participant=agent&since_id=${before.length + 30}`,
      { headers: { Authorization: `Bearer ${fixture.agentToken}` } }
    ).then((response) => response.json() as Promise<{ messages: Array<{ from: string; text: string; type: string }>; mentioned: boolean }>);

    const waited = await waitPromise;

    // Exactly one approval, authored by `system` — never as the agent or a human.
    const approvals = waited.messages.filter((message) => message.text.includes("auto-continue approved"));
    assert.equal(approvals.length, 1);
    const approval = approvals[0];
    assert.ok(approval);
    assert.equal(approval.from, "system");
    assert.equal(approval.type, "system");
    // It mentions only the alias whose post was rejected.
    assert.match(approval.text, /@agent\b/);
    assert.doesNotMatch(approval.text, /@host\b/);
    // The blocked participant is woken through its ordinary /wait response.
    assert.equal(waited.mentioned, true);

    // The rejected payload is never resubmitted.
    const log = await readMessages(fixture.root, fixture.roomId);
    assert.equal(log.filter((message) => message.text.includes("auto-continue approved")).length, 1);
    assert.equal(log.filter((message) => message.from === "agent" && message.text === "agent 30").length, 0);

    // The guard is re-armed: the agent can post again without a human /continue.
    const resumed = await jsonFetch(fixture, "POST", "/messages", fixture.agentToken, { text: "resuming work" });
    assert.equal(resumed.status, 201);

    const guard = await loopGuardOf(fixture, fixture.hostToken);
    assert.equal(guard.pending, false);
    assert.equal(guard.auto_continue_count, 1, "the process-local audit count records exactly one continuation");
  } finally {
    await fixture.close();
  }
});

// #249 (RE1): a pending continuation must never append an approval to a room
// that is no longer open. Cancellation now runs BEFORE the awaited `closeRoom`
// in both close paths, and `completeAutoContinue` re-reads the room's real
// status as the backstop for any close it did not observe.
//
// This closes the room through the STORAGE api, deliberately bypassing the HTTP
// handler's cancellation, so the armed timer survives and only the status guard
// can stop it. That makes the regression deterministic: a wall-clock test cannot
// reliably land inside the few-millisecond `await closeRoom` window, and an
// earlier version of this test passed against the unfixed code for exactly that
// reason.
test("a pending continuation that survives into a closed room appends no approval (#249)", { timeout: 90_000 }, async () => {
  const fixture = await startFixture();
  try {
    await jsonFetch(fixture, "POST", "/loop-guard", fixture.hostToken, { enabled: true, delay_s: 30 });
    assert.equal(await driveGuardToPause(fixture, fixture.agentToken), 429);
    assert.equal((await loopGuardOf(fixture, fixture.hostToken)).pending, true);

    // Close underneath the server: the timer stays armed.
    await closeRoom(fixture.root, fixture.roomId);

    // Wait past the deadline. Nothing may be appended to the closed room.
    await new Promise((resolve) => setTimeout(resolve, 33_000));
    const log = await readMessages(fixture.root, fixture.roomId);
    assert.equal(
      log.some((message) => message.text.includes("auto-continue approved")),
      false,
      "an approval was appended to a closed room"
    );
  } finally {
    await fixture.close();
  }
});

// #249 (operator, msg 1037): TTL expiry is PASSIVE. With no request after the
// room expires, no cancellation path runs at all — reordering the cancel cannot
// help. Only re-reading status AND the deadline inside `completeAutoContinue`,
// immediately before the append, prevents a continuation firing into an expired
// room. This test makes no request at all between the pause and the deadline.
test("a pending cycle that crosses room expiry with no intervening request appends nothing (#249)", { timeout: 90_000 }, async () => {
  // Expires while the 30s continuation is still pending.
  const fixture = await startFixture({ expiresAt: new Date(Date.now() + 5_000) });
  try {
    await jsonFetch(fixture, "POST", "/loop-guard", fixture.hostToken, { enabled: true, delay_s: 30 });
    assert.equal(await driveGuardToPause(fixture, fixture.agentToken), 429);
    assert.equal((await loopGuardOf(fixture, fixture.hostToken)).pending, true);

    // Deliberately no requests from here: nothing triggers the passive TTL close,
    // so the room's persisted status is still "open" when the timer fires.
    await new Promise((resolve) => setTimeout(resolve, 33_000));

    const log = await readMessages(fixture.root, fixture.roomId);
    assert.equal(
      log.some((message) => message.text.includes("auto-continue approved")),
      false,
      "a continuation fired into an expired room"
    );
  } finally {
    await fixture.close();
  }
});
