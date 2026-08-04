import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runDoctorCommand } from "../src/cli/commands/doctor/index.js";
import { runExportCommand } from "../src/cli/commands/export/index.js";
import { runSendCommand } from "../src/cli/commands/message/index.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { readMessages } from "../src/storage/index.js";

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
      home: await mkdtemp(path.join(os.tmpdir(), "agentgather-cli-diagnostics-test-")),
      stdout,
      stderr
    },
    stdout,
    stderr
  };
}

// #254: a TCP listener this test owns that resets every connection. It gives the
// CLI an unreachable room server — the condition these tests are about — without
// aiming a token-bearing request at a port the test does not control. The
// previous URLs (the product default port, and the discard port 9) both sent an
// Authorization header to a process the suite had not started; on a machine
// running `room serve` the doctor probe additionally made that foreign room
// allocate a read-cursor directory.
async function startUnreachableListener(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createNetServer((socket) => {
    socket.destroy();
  });
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

test("export writes a readable artifact without mutating source messages", async () => {
  const { context, stdout } = await makeContext();
  const unreachable = await startUnreachableListener();
  await runRoomCommand(["start", "export-room", "--alias", "operator", "--show-token", "--json"], context);
  const started = stdout.json<{ token: string }>();
  stdout.chunks = [];
  try {
    await runRoomCommand(
      ["join", "export-room", "--alias", "operator", "--token", started.token, "--url", unreachable.baseUrl],
      context
    );
  } finally {
    await unreachable.close();
  }
  await runRoomCommand(["invite", "reviewer"], context);
  await runSendCommand(["reviewer", "capture", "this"], context);
  const before = await readMessages(context.home, "export-room");
  const output = path.join(context.home, "room-export.md");

  stdout.chunks = [];
  await runExportCommand(["--output", output, "--json"], context);
  const exported = stdout.json<{ ok: true; output: string; messages: number }>();
  assert.equal(exported.output, output);
  assert.equal(exported.messages, before.length);

  const body = await readFile(output, "utf8");
  assert.match(body, /# Agent Gather Room Export: export-room/);
  assert.match(body, /@reviewer capture this/);
  assert.deepEqual(await readMessages(context.home, "export-room"), before);
});

test("doctor reports actionable checks without dumping bearer tokens", async () => {
  const { context, stdout } = await makeContext();
  const unreachable = await startUnreachableListener();
  try {
    await runRoomCommand(
      ["start", "doctor-room", "--alias", "operator", "--show-token", "--url", unreachable.baseUrl, "--json"],
      context
    );
    const started = stdout.json<{ token: string }>();

    stdout.chunks = [];
    const code = await runDoctorCommand(["--json"], context);
    const report = stdout.json<{ ok: boolean; checks: Array<{ name: string; ok: boolean; message: string }> }>();
    assert.equal(code, 1);
    assert.equal(report.checks.some((check) => check.name === "room-server" && !check.ok), true);
    assert.equal(JSON.stringify(report).includes(started.token), false);

    const tokenStore = path.join(context.home, "rooms", "doctor-room", "tokens.json");
    assert.equal((await stat(tokenStore)).isFile(), true);
  } finally {
    await unreachable.close();
  }
});
