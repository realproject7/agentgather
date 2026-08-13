import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand, type RoomCommandHooks } from "../src/cli/commands/room/index.js";
import { recordJoinedRoom, writeCurrent } from "../src/cli/state.js";
import { readParticipants, readRoomState, roomPaths } from "../src/storage/index.js";

// #310: a host-only room command run from a home that only JOINED the room used
// to fail with a raw ENOENT naming an internal absolute path. Three homes can
// name the same room, and each needs its own message, because "recreate the
// missing file" and "run this somewhere else" are opposite next actions.
//
// Every home here is a fresh `mkdtemp` root passed straight into the CliContext,
// which is how the other `cli-*` tests already work — nothing in this file reads
// or writes `AGENTGATHER_HOME` (that surface belongs to #305).

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

  json<T>(): T {
    return JSON.parse(this.text()) as T;
  }
}

interface Home {
  context: CliContext;
  stdout: Capture;
  stderr: Capture;
}

async function makeHome(): Promise<Home> {
  const stdout = new Capture();
  const stderr = new Capture();
  return {
    context: { home: await mkdtemp(path.join(os.tmpdir(), "agentgather-host-home-")), stdout, stderr },
    stdout,
    stderr
  };
}

// #254/#257: bind an ephemeral port, then release it, and point every room in
// this file at it. `brief set`, `attendance set` and `session start|end` POST to
// the current room's baseUrl before their local fallback; on this address that
// request is refused by the loopback stack rather than answered by whatever
// process happens to own the product default port on the developer's machine.
async function reserveRefusedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

// A bind failure injected into `room serve`, using the same seam #240 gave the
// listen path. In the host-home run below, `serve` must reach its listen step and
// then stop there — a real bind would hold the port and block on SIGINT forever.
const SERVE_BIND_FAILURE: RoomCommandHooks = {
  listen: async () => ({ ok: false, error: Object.assign(new Error("listen failed"), { code: "EADDRNOTAVAIL" }) })
};

// The complete host-only family: the twelve subcommands #310 names, plus `launch`
// and `serve`, added in review. `serve` is the reason those two belong here — it
// does not read host files, it stands the host's room server up over this home's
// room store and rewrites `current-room.json` on a successful bind, so from a
// participant home it would bind a port and then serve a room whose state is not
// there; `launch` builds and can spawn that same command. `runtime-status` is
// deliberately NOT here — it reads no host file and stays usable from a
// participant home (#310 scope decision); the test below pins that.
//
// The order is also a valid order to run them in against a real host home, which
// the last test does: the forum mutations follow the post they act on, the runtime
// commands precede `close`, and `close` comes last.
const HOST_ONLY_FAMILY: ReadonlyArray<{ command: string; argv: string[]; hooks?: RoomCommandHooks }> = [
  { command: "room invite", argv: ["invite", "project7", "--kind", "human"] },
  { command: "room invite-card", argv: ["invite-card", "project7"] },
  { command: "room channel-create", argv: ["channel-create", "design", "--type", "chat"] },
  { command: "room channel-rename", argv: ["channel-rename", "general", "--name", "General"] },
  { command: "room forum-post", argv: ["forum-post", "design-forum", "--title", "Kickoff", "--id", "kickoff"] },
  { command: "room forum-comment", argv: ["forum-comment", "design-forum", "kickoff", "--body", "Noted"] },
  { command: "room forum-status", argv: ["forum-status", "design-forum", "kickoff", "--status", "resolved"] },
  { command: "room brief set", argv: ["brief", "set", "Ship the release."] },
  { command: "room attendance set", argv: ["attendance", "set", "manual-ok"] },
  { command: "room session start", argv: ["session", "start", "--duration-m", "15"] },
  { command: "room session end", argv: ["session", "end"] },
  { command: "room launch", argv: ["launch", "--json"] },
  { command: "room serve", argv: ["serve"], hooks: SERVE_BIND_FAILURE },
  { command: "room close", argv: ["close"] }
];

// The three expected texts are written out here rather than imported from the
// implementation: importing the builder would assert only that a string equals
// itself. Each state's text is asserted for equality against its own home AND for
// inequality against the other two states' texts, so no assertion in this file can
// pass in more than one state.
function participantCopyError(command: string, roomId: string): string {
  return [
    `\`agentgather ${command}\` is a host-only command and this home is not the host of room "${roomId}".`,
    "This home holds a participant copy of that room: this device joined it, so it has none of the room's host files.",
    "Run it on the host device, or point AGENTGATHER_HOME at the home that hosts this room."
  ].join("\n");
}

function unknownRoomError(command: string, roomId: string): string {
  return [
    `\`agentgather ${command}\` is a host-only command and this home does not know room "${roomId}".`,
    "This home has neither a hosted room store nor a joined participant copy of it.",
    "Run it on the host device, or point AGENTGATHER_HOME at the home that hosts this room."
  ].join("\n");
}

function noCurrentRoomError(command: string): string {
  return [
    `\`agentgather ${command}\` is a host-only command and this home has no current room.`,
    "Run `agentgather room start <room>` to host a room in this home, or `agentgather room join` to join one."
  ].join("\n");
}

async function runFailing(argv: string[], context: CliContext, hooks: RoomCommandHooks = {}): Promise<Error> {
  try {
    await runRoomCommand(argv, context, hooks);
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error from room ${argv.join(" ")}`);
    return error;
  }
  throw new assert.AssertionError({ message: `room ${argv.join(" ")} unexpectedly succeeded` });
}

// Reproduces the reported topology exactly: one home hosts the room, a second
// home joins it with an invited participant token.
async function hostAndParticipantHomes(): Promise<{ host: Home; participant: Home; token: string; baseUrl: string }> {
  const host = await makeHome();
  const baseUrl = `http://127.0.0.1:${await reserveRefusedPort()}`;
  await runRoomCommand(
    ["create-boardroom", ROOM, "--alias", "host", "--channels", "general:chat,design-forum:forum", "--url", baseUrl, "--json"],
    host.context
  );
  host.stdout.chunks = [];
  await runRoomCommand(["invite", "project7", "--kind", "human", "--show-token", "--json"], host.context);
  const token = host.stdout.json<{ token: string }>().token;
  assert.match(token, /^tgl_/);

  const participant = await makeHome();
  await runRoomCommand(["join", ROOM, "--alias", "project7", "--token", token, "--url", baseUrl, "--json"], participant.context);
  return { host, participant, token, baseUrl };
}

test("the reported case: room invite in a participant-only home names the condition, not a missing file (#310)", async () => {
  const { participant, host, token } = await hostAndParticipantHomes();
  const paths = roomPaths(participant.context.home, ROOM);

  // The participant home really is the state from the report: it has the current
  // room and this device's own token store for it, and none of the host's files.
  await stat(paths.room);
  await assert.rejects(() => stat(paths.participants));
  await assert.rejects(() => stat(paths.state));

  const error = await runFailing(["invite", "someone", "--kind", "human"], participant.context);

  assert.equal(error.message, participantCopyError("room invite", ROOM));
  assert.notEqual(error.message, unknownRoomError("room invite", ROOM));
  assert.notEqual(error.message, noCurrentRoomError("room invite"));

  // The message must not be readable as "a file is missing", and must not leak
  // an internal path or a credential.
  assert.ok(!error.message.includes("ENOENT"));
  assert.ok(!error.message.includes("participants.json"));
  assert.ok(!error.message.includes(participant.context.home));
  assert.ok(!error.message.includes(host.context.home));
  assert.ok(!error.message.includes(os.tmpdir()));
  assert.ok(!error.message.includes(token));
  assert.ok(!error.message.includes("tgl_"));

  // Classified BEFORE the host-only read: the refused command wrote no host file
  // into the participant home.
  await assert.rejects(() => stat(paths.participants));
  await assert.rejects(() => stat(paths.state));
});

test("every host-only room command reports a participant-only home with the participant text (#310)", async () => {
  const { participant } = await hostAndParticipantHomes();
  for (const { command, argv, hooks } of HOST_ONLY_FAMILY) {
    const error = await runFailing(argv, participant.context, hooks);
    assert.equal(error.message, participantCopyError(command, ROOM), `wrong text for ${command}`);
    assert.notEqual(error.message, unknownRoomError(command, ROOM));
    assert.notEqual(error.message, noCurrentRoomError(command));
    assert.ok(!error.message.includes("ENOENT"), `${command} leaked ENOENT`);
    assert.ok(!error.message.includes(participant.context.home), `${command} leaked a home path`);
  }
});

test("every host-only room command reports a room unknown to this home with the unknown text (#310)", async () => {
  const home = await makeHome();
  // A current room this home has no copy of at all — neither a hosted room store
  // nor a joined one. Written through the CLI's own `current-room.json` writer.
  await writeCurrent(home.context.home, {
    roomId: ROOM,
    alias: "host",
    token: "tgl_unknown_room_token",
    baseUrl: `http://127.0.0.1:${await reserveRefusedPort()}`
  });
  await assert.rejects(() => stat(roomPaths(home.context.home, ROOM).room));

  for (const { command, argv, hooks } of HOST_ONLY_FAMILY) {
    const error = await runFailing(argv, home.context, hooks);
    assert.equal(error.message, unknownRoomError(command, ROOM), `wrong text for ${command}`);
    assert.notEqual(error.message, participantCopyError(command, ROOM));
    assert.notEqual(error.message, noCurrentRoomError(command));
    assert.ok(!error.message.includes("ENOENT"), `${command} leaked ENOENT`);
    assert.ok(!error.message.includes("tgl_unknown_room_token"), `${command} echoed the stored token`);
  }
});

test("every host-only room command reports a home with no current room with its own text (#310)", async () => {
  const home = await makeHome();
  for (const { command, argv, hooks } of HOST_ONLY_FAMILY) {
    const error = await runFailing(argv, home.context, hooks);
    assert.equal(error.message, noCurrentRoomError(command), `wrong text for ${command}`);
    assert.notEqual(error.message, participantCopyError(command, ROOM));
    assert.notEqual(error.message, unknownRoomError(command, ROOM));
    assert.ok(!error.message.includes("ENOENT"), `${command} leaked ENOENT`);
    assert.ok(!error.message.includes("current-room.json"), `${command} leaked an internal file name`);
  }
});

test("room runtime-status stays usable from a participant-only home (#310 scope decision)", async () => {
  const { participant } = await hostAndParticipantHomes();
  participant.stdout.chunks = [];

  // Read-only: it probes a URL and reports the runtime state, touching no host
  // file. Guarding it would take a working command away from a participant, so it
  // is deliberately outside the family above. This test fails if someone adds it.
  assert.equal(await runRoomCommand(["runtime-status", "--json"], participant.context), 0);
  const status = participant.stdout.json<{ ok: true; room: string; runtime_state: string }>();
  assert.equal(status.ok, true);
  assert.equal(status.room, ROOM);
  // The room's baseUrl is a reserved-and-released port, so the runtime is not
  // reachable; which of the two unreachable states it reports depends on whether
  // this machine has tmux, so assert the set rather than pin the runner's tooling.
  assert.ok(
    ["runtime-unreachable", "manual-run-required"].includes(status.runtime_state),
    `unexpected runtime_state ${status.runtime_state}`
  );
  assert.ok(!participant.stdout.text().includes("tgl_"), "runtime-status echoed a token");
});

test("a joined-rooms row with no room directory is still a participant copy, not an unknown room (#310)", async () => {
  const home = await makeHome();
  const baseUrl = `http://127.0.0.1:${await reserveRefusedPort()}`;
  const now = new Date().toISOString();
  // The dashboard's invite import records a joined-rooms row (#178/#248) without
  // this device ever running `room join`, so there is no `rooms/<id>/` directory.
  // The device has still joined the room, so "unknown to this home" would be wrong.
  await writeCurrent(home.context.home, { roomId: ROOM, alias: "project7", token: "tgl_imported_row_token", baseUrl });
  await recordJoinedRoom(home.context.home, { roomId: ROOM, title: ROOM, alias: "project7", baseUrl, joinedAt: now, lastSeen: now });
  await assert.rejects(() => stat(roomPaths(home.context.home, ROOM).room));

  const error = await runFailing(["invite", "someone", "--kind", "human"], home.context);
  assert.equal(error.message, participantCopyError("room invite", ROOM));
  assert.notEqual(error.message, unknownRoomError("room invite", ROOM));
  assert.notEqual(error.message, noCurrentRoomError("room invite"));
  assert.ok(!error.message.includes("tgl_imported_row_token"));
});

test("a host home whose room.json was removed is not reported as a participant copy (#310)", async () => {
  const { host } = await hostAndParticipantHomes();
  const paths = roomPaths(host.context.home, ROOM);
  await rm(paths.state);

  // This home still holds the host's own participants.json, so it is a damaged
  // host store, not a copy someone joined. Substituting the participant message
  // here would be the same wrong-kind-of-failure this ticket is about, so the
  // command keeps its existing behavior instead.
  const error = await runFailing(["close"], host.context);
  assert.notEqual(error.message, participantCopyError("room close", ROOM));
  assert.notEqual(error.message, unknownRoomError("room close", ROOM));
  assert.notEqual(error.message, noCurrentRoomError("room close"));

  // And a host-only command that does not need room.json still works, exactly as
  // it did before this change.
  assert.equal(await runRoomCommand(["invite", "second", "--kind", "agent"], host.context), 0);
  assert.ok((await readParticipants(paths)).some((entry) => entry.alias === "second"));
});

test("a host-owned home still runs the whole host-only family unchanged (#310)", async () => {
  const { host } = await hostAndParticipantHomes();
  for (const { command, argv, hooks } of HOST_ONLY_FAMILY) {
    host.stdout.chunks = [];
    const code = await runRoomCommand(argv, host.context, hooks);
    // `serve` is the one member that cannot succeed here without holding a port
    // and blocking on SIGINT, so it runs with an injected bind failure. Exit 1
    // from the bind path is still proof it got past the classification — a
    // participant home never reaches `listen` at all.
    const expected = command === "room serve" ? 1 : 0;
    assert.equal(code, expected, `${command} did not get past classification in the host home`);
  }
  assert.match(host.stderr.text(), /Cannot bind 127\.0\.0\.1:\d+: address not available/);

  // Not just exit codes: the host home's own files carry what the family wrote.
  const paths = roomPaths(host.context.home, ROOM);
  const participants = await readParticipants(paths);
  assert.deepEqual(
    participants.map((entry) => entry.alias).sort(),
    ["host", "project7"]
  );
  const state = await readRoomState(paths);
  assert.equal(state.status, "closed");
  assert.equal(state.attendance_policy, "manual-ok");
});
