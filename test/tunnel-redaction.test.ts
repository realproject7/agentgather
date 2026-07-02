import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { createRoomHttpServer } from "../src/server/index.js";
import {
  type BrokerLogSink,
  BrokerLogger,
  classifyPath,
  createBrokerHttpServer,
  routeHash,
  TunnelBroker,
  TunnelClient
} from "../src/tunnel/index.js";

class Capture extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _e: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    cb();
  }
  json<T>(): T {
    return JSON.parse(this.chunks.join("")) as T;
  }
  reset(): void {
    this.chunks = [];
  }
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("BrokerLogger emits only allowlisted fields and drops anything else", () => {
  const records: Array<Record<string, unknown>> = [];
  const sink: BrokerLogSink = (record) => records.push({ ...record });
  const logger = new BrokerLogger(sink);

  logger.log({
    event: "forward",
    route_hash: "abc123",
    method: "POST",
    path_class: "messages",
    status: 201,
    duration_ms: 5,
    bytes_in: 10,
    bytes_out: 20,
    // Fields outside the allowlist must never reach the sink.
    ...({ authorization: "Bearer tgl_secret", text: "secret message", token: "tgl_secret" } as object)
  });

  const record = records[0] ?? {};
  assert.equal(record.authorization, undefined);
  assert.equal(record.text, undefined);
  assert.equal(record.token, undefined);
  assert.equal(record.path_class, "messages");
  assert.equal(JSON.stringify(record).includes("tgl_secret"), false);
});

test("routeHash hides the slug and classifyPath drops query strings", () => {
  assert.notEqual(routeHash("demo-room"), "demo-room");
  assert.equal(routeHash("demo-room"), routeHash("demo-room"));
  assert.equal(classifyPath("/card?participant=alice&token=tgl_secret"), "card");
  assert.equal(classifyPath("/wait?participant=alice&since_id=0"), "wait");
  assert.equal(classifyPath("/messages"), "messages");
  assert.equal(classifyPath("/"), "shell");
  assert.equal(classifyPath("/room.css"), "asset");
  assert.equal(classifyPath("/theme.css"), "asset");
  assert.equal(classifyPath("/agentgather-logo.png"), "asset");
  assert.equal(classifyPath("/secret/path?x=y"), "other");
});

test("broker access logs never contain tokens, query strings, message text, or brief bodies", async () => {
  const stdout = new Capture();
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "agentgather-redact-test-")),
    stdout,
    stderr: new Capture()
  };
  const hostPort = await getFreePort();
  const hostBaseUrl = `http://127.0.0.1:${hostPort}`;
  const SECRET_BRIEF = "SECRET-BRIEF-do-not-log";

  await runRoomCommand(
    ["start", "demo-room", "--alias", "host", "--brief", SECRET_BRIEF, "--url", hostBaseUrl, "--json"],
    context
  );
  stdout.reset();
  await runRoomCommand(["invite", "reviewer", "--kind", "agent", "--show-token", "--json"], context);
  const token = stdout.json<{ token: string }>().token;

  const records: Array<Record<string, unknown>> = [];
  const broker = new TunnelBroker({ routeTtlMs: 60_000, logSink: (record) => records.push({ ...record }) });
  const brokerServer = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => brokerServer.listen(0, "127.0.0.1", resolve));
  const brokerBaseUrl = `http://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`;
  const publicBaseUrl = `${brokerBaseUrl}/demo-room`;

  const hostServer = createRoomHttpServer({
    root: context.home,
    roomId: "demo-room",
    baseUrl: hostBaseUrl,
    rateLimitPerMinute: 1_000,
    publicBaseUrl: () => publicBaseUrl
  });
  await new Promise<void>((resolve) => hostServer.listen(hostPort, "127.0.0.1", resolve));
  await new TunnelClient(brokerBaseUrl).register("demo-room", hostBaseUrl);

  try {
    await fetch(`${publicBaseUrl}/card?participant=reviewer&token=${token}`);
    await fetch(`${publicBaseUrl}/brief`, { headers: { Authorization: `Bearer ${token}` } });
    await fetch(`${publicBaseUrl}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "@host SECRET-MESSAGE-do-not-log" })
    });

    assert.equal(records.length > 0, true);
    const serialized = JSON.stringify(records);
    for (const secret of [token, "SECRET-MESSAGE-do-not-log", SECRET_BRIEF, "token=", "Authorization", "Bearer", "demo-room"]) {
      assert.equal(serialized.includes(secret), false, `log leaked: ${secret}`);
    }
    // Coarse, safe fields are present.
    assert.equal(serialized.includes("route_hash"), true);
    assert.equal(serialized.includes("path_class"), true);
  } finally {
    await new Promise<void>((resolve) => brokerServer.close(() => resolve()));
    await new Promise<void>((resolve) => hostServer.close(() => resolve()));
  }
});
