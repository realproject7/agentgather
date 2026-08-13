import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import type { Server } from "node:http";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { writeCurrent, writeToken } from "../src/cli/state.js";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
import { createRoom, readMessages, readParticipants, roomPaths, writeParticipants } from "../src/storage/index.js";
import type { Participant } from "../src/protocol/index.js";
import { closeServer } from "./support/close-server.js";

// #314 — `room leave` from a joined copy used to fail with a raw ENOENT on the
// HOST's `participants.json`, because it edited host files directly and a
// participant device has none.
//
// It is the sibling of #310, and deliberately NOT its remedy: telling a
// participant to point `AGENTGATHER_HOME` at the host's home would be worse than
// the ENOENT, since they do not have that home and leaving is theirs to do from
// here. Every assertion below therefore checks two things — that the message is
// exactly right for its state, and that it is NOT #310's.

const ROOM = "ape-cards-20260706-194024";

class Capture extends Writable {
  chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

interface Home {
  context: CliContext;
  stdout: Capture;
}

async function makeHome(prefix: string): Promise<Home> {
  const stdout = new Capture();
  return {
    context: { home: await mkdtemp(path.join(os.tmpdir(), `agentgather-${prefix}-`)), stdout, stderr: new Capture() },
    stdout
  };
}

// #254/#257: reserved, then released. A room pointed here is refused by the
// loopback stack rather than answered by whatever owns the product default port.
async function refusedBaseUrl(): Promise<string> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

async function listen(server: Server): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
}

function participant(alias: string, isHost: boolean, token: string): Participant {
  const now = new Date().toISOString();
  return {
    alias,
    kind: isHost ? "human" : "agent",
    location: "local",
    install: isHost ? "host" : "lite",
    attention: "attending",
    is_host: isHost,
    token_hash: participantTokenHash(token),
    joinedAt: now,
    lastSeenAt: now
  };
}

// The exact text for each state, written out here rather than imported: importing
// the builder would assert only that a string equals itself. Each is asserted for
// equality against its own state AND for inequality against the others.
const NO_CURRENT_ROOM = [
  "`agentgather room leave` has no room to leave: this home has no current room.",
  "Run `agentgather room join <room> --alias <you> --token <invite>` to join one."
].join("\n");

function unknownRoom(roomId: string): string {
  return [
    `\`agentgather room leave\` has nothing to leave for room "${roomId}": this home holds no copy of it.`,
    "Run `agentgather room current` to see what this home points at, or `agentgather room join` to join that room again."
  ].join("\n");
}

function hostUnreachable(roomId: string): string {
  return [
    `\`agentgather room leave\` could not reach the host of room "${roomId}", so your departure was not announced.`,
    "Nothing changed: this device still holds its copy of the room, and no credential was altered.",
    "Try again while the host is serving the room, or leave from the room page in your dashboard."
  ].join("\n");
}

// #310's host-only wording, for the inequality checks. If #310's text ever
// changes, these copies drift and the distinctness assertions weaken — so each
// test also asserts the property that matters directly: no leave message may
// carry the host-home remedy.
const HOST_HOME_REMEDY = "Run it on the host device, or point AGENTGATHER_HOME at the home that hosts this room.";

async function runFailing(argv: string[], context: CliContext): Promise<Error> {
  try {
    await runRoomCommand(argv, context);
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error from room ${argv.join(" ")}`);
    return error;
  }
  throw new assert.AssertionError({ message: `room ${argv.join(" ")} unexpectedly succeeded` });
}

// A host home serving ROOM, plus a joined participant home pointed at it.
async function hostAndParticipant(): Promise<{
  host: Home;
  participant: Home;
  server: { baseUrl: string; close: () => Promise<void> };
  participantToken: string;
}> {
  const host = await makeHome("leave-host");
  const participantToken = "tgl_participant_leave_token";
  const hostToken = "tgl_host_leave_token";
  await createRoom({ root: host.context.home, roomId: ROOM, hostAlias: "pb-lead" });
  await writeParticipants(host.context.home, ROOM, [
    participant("pb-lead", true, hostToken),
    participant("project7", false, participantToken)
  ]);
  const server = await listen(createRoomHttpServer({ root: host.context.home, roomId: ROOM, baseUrl: "http://127.0.0.1:0" }));
  await writeCurrent(host.context.home, { roomId: ROOM, alias: "pb-lead", token: hostToken, baseUrl: server.baseUrl });
  await writeToken(host.context.home, ROOM, "pb-lead", hostToken);

  const participantHome = await makeHome("leave-participant");
  await runRoomCommand(
    ["join", ROOM, "--alias", "project7", "--token", participantToken, "--url", server.baseUrl, "--json"],
    participantHome.context
  );
  return { host, participant: participantHome, server, participantToken };
}

test("a participant leaves through the host's room server, and the host sees it (#314)", async () => {
  const { host, participant: joined, server } = await hostAndParticipant();
  try {
    // The fixture's `room join` printed to this same capture.
    joined.stdout.chunks = [];
    const code = await runRoomCommand(["leave"], joined.context);
    assert.equal(code, 0);
    assert.equal(joined.stdout.text(), `You left ${ROOM} as project7. The host was notified.\n`);

    // The departure is only real if the HOST's own files carry it. Asserting the
    // CLI's own output would prove the message, not the leave.
    const roster = await readParticipants(roomPaths(host.context.home, ROOM));
    assert.equal(roster.find((entry) => entry.alias === "project7")?.attention, "away");
    assert.equal(roster.find((entry) => entry.alias === "pb-lead")?.attention, "attending", "only the leaver moves");
    const messages = await readMessages(host.context.home, ROOM);
    assert.ok(
      messages.some((message) => message.from === "system" && message.text === "project7 left"),
      "the host's log must carry the departure"
    );

    // Nothing host-owned was written into the participant's home.
    await assert.rejects(() => stat(roomPaths(joined.context.home, ROOM).participants));
    await assert.rejects(() => stat(roomPaths(joined.context.home, ROOM).state));
  } finally {
    await server.close();
  }
});

test("a participant whose host is unreachable is told exactly that, and nothing changes (#314)", async () => {
  const { participant: joined, server, participantToken } = await hostAndParticipant();
  await server.close();

  const error = await runFailing(["leave"], joined.context);
  assert.equal(error.message, hostUnreachable(ROOM));
  assert.notEqual(error.message, unknownRoom(ROOM));
  assert.notEqual(error.message, NO_CURRENT_ROOM);

  // #314's whole point: this must not read as #310's host-only refusal, and must
  // never send a participant to a host home they do not have.
  assert.equal(error.message.includes(HOST_HOME_REMEDY), false, "a participant was sent to a host home");
  assert.equal(/AGENTGATHER_HOME/.test(error.message), false, "the remedy must not mention the host's home");
  assert.equal(/host-only/.test(error.message), false, "leave is not a host-only command");

  // No path, no token.
  assert.equal(error.message.includes("ENOENT"), false);
  assert.equal(error.message.includes("participants.json"), false);
  assert.equal(error.message.includes(joined.context.home), false);
  assert.equal(error.message.includes(os.tmpdir()), false);
  assert.equal(error.message.includes(participantToken), false);
  assert.equal(/tgl_/.test(error.message), false);

  // "Nothing changed" is asserted, not just claimed.
  await assert.rejects(() => stat(roomPaths(joined.context.home, ROOM).participants));
  await assert.rejects(() => stat(roomPaths(joined.context.home, ROOM).state));
});

test("a host that answers and REFUSES is reported with its own reason, not as unreachable (#314)", async () => {
  // The distinction the participant branch is built on: "no server answered" and
  // "the server said no" are different problems with different next actions.
  // Flattening the second into the first would send the reader to restart a host
  // that is already running.
  const { participant: joined, server } = await hostAndParticipant();
  try {
    // A credential the room does not know. The server answers 403 with its reason.
    await writeCurrent(joined.context.home, {
      roomId: ROOM,
      alias: "project7",
      token: "tgl_a_token_this_room_never_issued",
      baseUrl: server.baseUrl
    });

    const error = await runFailing(["leave"], joined.context);
    assert.equal(error.message, "participant token is not allowed");
    assert.notEqual(error.message, hostUnreachable(ROOM), "a refusal must not read as unreachable");
    assert.equal(error.message.includes(HOST_HOME_REMEDY), false);
    assert.equal(/tgl_/.test(error.message), false, "the rejected token must not be echoed back");
    assert.equal(error.message.includes(joined.context.home), false);
  } finally {
    await server.close();
  }
});

test("leaving a room this home holds no copy of says so, distinctly (#314)", async () => {
  const home = await makeHome("leave-unknown");
  await writeCurrent(home.context.home, {
    roomId: ROOM,
    alias: "project7",
    token: "tgl_unknown_room_token",
    baseUrl: await refusedBaseUrl()
  });

  const error = await runFailing(["leave"], home.context);
  assert.equal(error.message, unknownRoom(ROOM));
  assert.notEqual(error.message, hostUnreachable(ROOM));
  assert.notEqual(error.message, NO_CURRENT_ROOM);
  assert.equal(error.message.includes(HOST_HOME_REMEDY), false);
  assert.equal(/AGENTGATHER_HOME|host-only|ENOENT/.test(error.message), false);
  assert.equal(error.message.includes("tgl_unknown_room_token"), false);
});

test("leaving with no current room says there is nothing to leave, distinctly (#314)", async () => {
  const home = await makeHome("leave-none");

  const error = await runFailing(["leave"], home.context);
  assert.equal(error.message, NO_CURRENT_ROOM);
  assert.notEqual(error.message, unknownRoom(ROOM));
  assert.notEqual(error.message, hostUnreachable(ROOM));
  assert.equal(error.message.includes(HOST_HOME_REMEDY), false);
  assert.equal(/AGENTGATHER_HOME|host-only|ENOENT|current-room\.json/.test(error.message), false);
});

test("a host leaving its own room keeps the pre-#314 local behavior (#314)", async () => {
  const host = await makeHome("leave-hosthome");
  const hostToken = "tgl_host_only_token";
  await createRoom({ root: host.context.home, roomId: ROOM, hostAlias: "pb-lead" });
  await writeParticipants(host.context.home, ROOM, [participant("pb-lead", true, hostToken)]);
  // A refused base URL: the host path must not depend on a reachable server, which
  // is exactly what "unchanged" means here.
  await writeCurrent(host.context.home, {
    roomId: ROOM,
    alias: "pb-lead",
    token: hostToken,
    baseUrl: await refusedBaseUrl()
  });

  const code = await runRoomCommand(["leave", "--json"], host.context);
  assert.equal(code, 0);
  assert.equal(host.stdout.text(), '{"ok":true}\n');

  const roster = await readParticipants(roomPaths(host.context.home, ROOM));
  assert.equal(roster.find((entry) => entry.alias === "pb-lead")?.attention, "away");
  const messages = await readMessages(host.context.home, ROOM);
  assert.ok(messages.some((message) => message.from === "system" && message.text === "pb-lead left"));
});
