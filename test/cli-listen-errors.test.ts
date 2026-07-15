import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runBrokerCommand } from "../src/cli/commands/broker/index.js";
import { runPlatformCommand } from "../src/cli/commands/platform/index.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { listenErrorMessage, listenOrError, type ListenOutcome } from "../src/cli/commands/listen.js";

class Capture extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _e: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
}

async function makeContext(): Promise<{ context: CliContext; out: Capture; err: Capture }> {
  const out = new Capture();
  const err = new Capture();
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "agentgather-listen-test-")),
    stdout: out,
    stderr: err
  };
  return { context, out, err };
}

// Occupy a real localhost port for the duration of a test so a serve command hits
// a genuine EADDRINUSE. Returns the port and a close function.
async function occupyPort(): Promise<{ port: number; server: Server; close: () => Promise<void> }> {
  const server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, server, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function isListening(server: Server): boolean {
  return server.listening;
}

// A deterministic injected listen error — no OS hostname resolution — for the
// invalid-bind path.
function injectListenError(code: string): { listen: (s: Server, p: number, h: string) => Promise<ListenOutcome> } {
  return {
    listen: async () => ({ ok: false, error: Object.assign(new Error("listen failed"), { code }) })
  };
}

const TOKEN_MARKERS = /tgl_|token=|Bearer|Authorization/i;

// ---- shared helper (the seam launch/#232 now delegates to) -----------------

test("listenOrError resolves ok on a free port and failure on an occupied one, without throwing", async () => {
  const free = await new Promise<number>((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

  const okServer = createServer((_req, res) => res.end());
  const ok = await listenOrError(okServer, free, "127.0.0.1");
  assert.equal(ok.ok, true);
  await new Promise<void>((resolve) => okServer.close(() => resolve()));

  const occupied = await occupyPort();
  const clash = createServer((_req, res) => res.end());
  try {
    const outcome = await listenOrError(clash, occupied.port, "127.0.0.1");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error?.code, "EADDRINUSE");
    assert.equal(clash.listening, false);
  } finally {
    await occupied.close();
  }
});

test("listenErrorMessage is controlled and token-free for each bind failure", () => {
  const inUse = listenErrorMessage("127.0.0.1", 8799, Object.assign(new Error(), { code: "EADDRINUSE" }));
  assert.match(inUse, /127\.0\.0\.1:8799/);
  assert.match(inUse, /already in use/);
  assert.equal(TOKEN_MARKERS.test(inUse), false);

  assert.match(listenErrorMessage("127.0.0.1", 1, Object.assign(new Error(), { code: "EACCES" })), /permission denied/);
  assert.match(
    listenErrorMessage("127.0.0.1", 8788, Object.assign(new Error(), { code: "EADDRNOTAVAIL" })),
    /not available/
  );
  assert.match(listenErrorMessage("127.0.0.1", 8787, undefined), /Cannot bind 127\.0\.0\.1:8787/);
});

// ---- broker serve ----------------------------------------------------------

test("broker serve: occupied port exits non-zero with a token-free error and never touches the foreign listener", async () => {
  const { context, out, err } = await makeContext();
  const occupied = await occupyPort();
  try {
    const code = await runBrokerCommand(["serve", "--port", String(occupied.port)], context);
    assert.equal(code, 1);
    assert.match(err.text(), new RegExp(`Cannot bind 127\\.0\\.0\\.1:${occupied.port}: address already in use`));
    assert.equal(TOKEN_MARKERS.test(err.text()), false);
    assert.equal(out.text().includes("broker serving"), false); // never announced a bind
    assert.equal(isListening(occupied.server), true); // foreign listener untouched
  } finally {
    await occupied.close();
  }
});

test("broker serve: an injected invalid-bind error exits non-zero, token-free (no hostname dependency)", async () => {
  const { context, err } = await makeContext();
  const code = await runBrokerCommand(
    ["serve", "--port", "8799"],
    context,
    injectListenError("EADDRNOTAVAIL")
  );
  assert.equal(code, 1);
  assert.match(err.text(), /Cannot bind 127\.0\.0\.1:8799: address not available/);
  assert.equal(TOKEN_MARKERS.test(err.text()), false);
});

// ---- platform serve --------------------------------------------------------

test("platform serve: occupied port exits non-zero, token-free, foreign listener untouched", async () => {
  const { context, out, err } = await makeContext();
  const occupied = await occupyPort();
  try {
    const code = await runPlatformCommand(["serve", "--port", String(occupied.port)], context);
    assert.equal(code, 1);
    assert.match(err.text(), new RegExp(`Cannot bind 127\\.0\\.0\\.1:${occupied.port}: address already in use`));
    assert.equal(TOKEN_MARKERS.test(err.text()), false);
    assert.equal(out.text().includes("Serving the control-plane"), false);
    assert.equal(isListening(occupied.server), true);
  } finally {
    await occupied.close();
  }
});

test("platform serve: an injected invalid-bind error exits non-zero, token-free", async () => {
  const { context, err } = await makeContext();
  const code = await runPlatformCommand(
    ["serve", "--port", "8788"],
    context,
    injectListenError("EADDRNOTAVAIL")
  );
  assert.equal(code, 1);
  assert.match(err.text(), /Cannot bind 127\.0\.0\.1:8788: address not available/);
  assert.equal(TOKEN_MARKERS.test(err.text()), false);
});

// ---- room serve ------------------------------------------------------------

async function startRoom(context: CliContext): Promise<void> {
  const code = await runRoomCommand(["start", "svc-room", "--alias", "operator", "--json"], context);
  assert.equal(code, 0);
}

test("room serve: occupied port exits non-zero, token-free, foreign listener untouched", async () => {
  const { context, out, err } = await makeContext();
  await startRoom(context);
  const occupied = await occupyPort();
  try {
    const code = await runRoomCommand(["serve", "--port", String(occupied.port)], context);
    assert.equal(code, 1);
    assert.match(err.text(), new RegExp(`Cannot bind 127\\.0\\.0\\.1:${occupied.port}: address already in use`));
    assert.equal(TOKEN_MARKERS.test(err.text()), false);
    assert.equal(out.text().includes("Serving svc-room"), false);
    assert.equal(isListening(occupied.server), true);
  } finally {
    await occupied.close();
  }
});

test("room serve: an injected invalid-bind error exits non-zero, token-free", async () => {
  const { context, err } = await makeContext();
  await startRoom(context);
  const code = await runRoomCommand(
    ["serve", "--port", "8787"],
    context,
    injectListenError("EADDRNOTAVAIL")
  );
  assert.equal(code, 1);
  assert.match(err.text(), /Cannot bind 127\.0\.0\.1:8787: address not available/);
  assert.equal(TOKEN_MARKERS.test(err.text()), false);
});
