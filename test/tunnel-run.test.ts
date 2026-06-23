import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { runTunnelCommand } from "../src/cli/commands/tunnel/index.js";
import { createRoomHttpServer } from "../src/server/index.js";
import { createBrokerHttpServer, HostTunnelSession, TunnelBroker, TunnelClient } from "../src/tunnel/index.js";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await delay(10);
  }
}

interface Fixture {
  publicBaseUrl: string;
  hostToken: string;
  reviewerToken: string;
  hostBaseUrl: string;
  routeId: string;
  hostConnectionId: string;
  client: TunnelClient;
  broker: TunnelBroker;
  close: () => Promise<void>;
}

async function setup(options: { waitHoldMs?: number; brokerOptions?: ConstructorParameters<typeof TunnelBroker>[0] } = {}): Promise<Fixture> {
  const stdout = new Capture();
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "agentgather-run-test-")),
    stdout,
    stderr: new Capture()
  };
  const hostPort = await getFreePort();
  const hostBaseUrl = `http://127.0.0.1:${hostPort}`;

  await runRoomCommand(["start", "demo-room", "--alias", "host", "--brief", "Run it.", "--url", hostBaseUrl, "--json"], context);
  const hostToken = stdout.json<{ token: string }>().token;
  stdout.reset();
  await runRoomCommand(["invite", "reviewer", "--kind", "agent", "--json"], context);
  const reviewerToken = stdout.json<{ token: string }>().token;

  const broker = new TunnelBroker(options.brokerOptions ?? { routeTtlMs: 60_000, logSink: () => {} });
  const brokerServer = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => brokerServer.listen(0, "127.0.0.1", resolve));
  const brokerBaseUrl = `http://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`;
  const publicBaseUrl = `${brokerBaseUrl}/demo-room`;

  const hostServer = createRoomHttpServer({
    root: context.home,
    roomId: "demo-room",
    baseUrl: hostBaseUrl,
    waitHoldMs: options.waitHoldMs ?? 60,
    rateLimitPerMinute: 1_000,
    publicBaseUrl: () => publicBaseUrl
  });
  await new Promise<void>((resolve) => hostServer.listen(hostPort, "127.0.0.1", resolve));

  const client = new TunnelClient(brokerBaseUrl);
  const { route } = await client.register("demo-room");

  return {
    publicBaseUrl,
    hostToken,
    reviewerToken,
    hostBaseUrl,
    routeId: route.route_id,
    hostConnectionId: route.host_connection_id,
    client,
    broker,
    close: async () => {
      await new Promise<void>((resolve) => brokerServer.close(() => resolve()));
      await new Promise<void>((resolve) => hostServer.close(() => resolve()));
    }
  };
}

function startSession(fixture: Fixture, overrides: { concurrency?: number; pollIntervalMs?: number; heartbeatIntervalMs?: number } = {}): HostTunnelSession {
  const session = new HostTunnelSession(fixture.client, {
    routeId: fixture.routeId,
    hostConnectionId: fixture.hostConnectionId,
    target: fixture.hostBaseUrl,
    pollIntervalMs: overrides.pollIntervalMs ?? 10,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 1_000,
    ...(overrides.concurrency !== undefined ? { concurrency: overrides.concurrency } : {})
  });
  session.start();
  return session;
}

test("the run session relays the full participant flow through the broker", async () => {
  const fixture = await setup();
  const session = startSession(fixture);
  try {
    const auth = { Authorization: `Bearer ${fixture.reviewerToken}` };

    const card = await fetch(`${fixture.publicBaseUrl}/card?participant=reviewer&token=${fixture.reviewerToken}`);
    assert.equal(card.status, 200);
    assert.match(await card.text(), /Run it\./);

    assert.equal((await fetch(`${fixture.publicBaseUrl}/join`, { method: "POST", headers: auth })).status, 200);

    const sent = await fetch(`${fixture.publicBaseUrl}/messages`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "@host run flow" })
    });
    assert.equal(sent.status, 201);

    const read = await fetch(`${fixture.publicBaseUrl}/messages?since_id=0`, { headers: auth });
    assert.equal(read.status, 200);

    const wait = await fetch(`${fixture.publicBaseUrl}/wait?participant=reviewer&since_id=999`, { headers: auth });
    assert.equal((await wait.json()).heartbeat, true);

    const shell = await fetch(`${fixture.publicBaseUrl}/`);
    assert.equal(shell.status, 200);
    assert.equal((await fetch(`${fixture.publicBaseUrl}/room.css`)).status, 200);
    const script = await fetch(`${fixture.publicBaseUrl}/room.js`);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /sessionStorage/);
  } finally {
    await session.stop();
    await fixture.close();
  }
});

test("a held /wait does not block a normal request behind it", async () => {
  const fixture = await setup({ waitHoldMs: 300 });
  const session = startSession(fixture, { concurrency: 2 });
  try {
    const auth = { Authorization: `Bearer ${fixture.reviewerToken}` };
    const held = fetch(`${fixture.publicBaseUrl}/wait?participant=reviewer&since_id=999`, { headers: auth }).then(() => "wait");
    await delay(20);
    const normal = fetch(`${fixture.publicBaseUrl}/status`, { headers: auth }).then(() => "status");

    // With bounded concurrency > 1 the fast /status resolves before the held /wait.
    const winner = await Promise.race([held, normal]);
    assert.equal(winner, "status");
    await Promise.all([held, normal]);
  } finally {
    await session.stop();
    await fixture.close();
  }
});

test("stopping the session with closeRoute closes the broker route", async () => {
  const fixture = await setup();
  const session = startSession(fixture);
  await session.stop({ closeRoute: true });
  try {
    assert.throws(
      () => fixture.broker.resolve("demo-room"),
      (error: unknown) => error instanceof Error && /closed/.test(error.message)
    );
  } finally {
    await fixture.close();
  }
});

test("the foreground run session keeps the process alive while attending", async () => {
  const fixture = await setup();
  const session = startSession(fixture, { heartbeatIntervalMs: 10_000, pollIntervalMs: 10_000 });
  try {
    const internals = session as unknown as { heartbeatTimer?: NodeJS.Timeout };
    assert.equal(internals.heartbeatTimer?.hasRef(), true);
  } finally {
    await session.stop();
    await fixture.close();
  }
});

test("tunnel run installs a signal shutdown that closes the route and prints status", async () => {
  const stdout = new Capture();
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "agentgather-run-signal-")),
    stdout,
    stderr: new Capture()
  };
  await runRoomCommand(["start", "demo-room", "--alias", "host", "--json"], context);
  const hostToken = stdout.json<{ token: string }>().token;

  const broker = new TunnelBroker({ routeTtlMs: 60_000, logSink: () => {} });
  const brokerServer = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => brokerServer.listen(0, "127.0.0.1", resolve));
  const brokerBaseUrl = `http://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`;

  stdout.reset();
  const runPromise = runTunnelCommand(
    ["run", "--broker", brokerBaseUrl, "--subdomain", "demo-room", "--target", "http://127.0.0.1:8787"],
    context
  );
  try {
    await waitFor(() => stdout.chunks.join("").includes("Tunnel running"));
    await delay(20);
    assert.equal(broker.resolve("demo-room").status, "active");

    process.emit("SIGINT");
    const code = await runPromise;

    assert.equal(code, 0);
    const output = stdout.chunks.join("");
    assert.match(output, /Tunnel running/);
    assert.match(output, /Tunnel closed \(signal\)/);
    assert.throws(
      () => broker.resolve("demo-room"),
      (error: unknown) => error instanceof Error && /closed/.test(error.message)
    );
    assert.equal(output.includes(hostToken), false);
    assert.equal(output.includes("Bearer"), false);
  } finally {
    await new Promise<void>((resolve) => brokerServer.close(() => resolve()));
  }
});

test("a new host session reclaims the slug after the prior host stops", async () => {
  const fixture = await setup({ brokerOptions: { routeTtlMs: 60_000, hostGraceMs: 60, logSink: () => {} } });
  const auth = { Authorization: `Bearer ${fixture.reviewerToken}` };

  const first = startSession(fixture);
  try {
    assert.equal((await fetch(`${fixture.publicBaseUrl}/status`, { headers: auth })).status, 200);
  } finally {
    await first.stop();
  }

  // The prior host stopped; after the grace window the route is
  // host-disconnected and forwards fail with a bounded error rather than hang.
  await delay(150);
  const stale = await fetch(`${fixture.publicBaseUrl}/status`, { headers: auth });
  assert.equal(stale.status, 504);
  assert.equal(((await stale.json()) as { error: string }).error, "host_unavailable");

  // A new host tunnel session re-registers the same slug and serves again.
  const reclaimed = await fixture.client.register("demo-room");
  assert.notEqual(reclaimed.route.route_id, fixture.routeId);
  const second = new HostTunnelSession(fixture.client, {
    routeId: reclaimed.route.route_id,
    hostConnectionId: reclaimed.route.host_connection_id,
    target: fixture.hostBaseUrl,
    pollIntervalMs: 10,
    heartbeatIntervalMs: 1_000
  });
  second.start();
  try {
    assert.equal((await fetch(`${fixture.publicBaseUrl}/status`, { headers: auth })).status, 200);
  } finally {
    await second.stop();
    await fixture.close();
  }
});

test("the heartbeat keeps the route alive past the idle timeout", async () => {
  const fixture = await setup({ brokerOptions: { routeTtlMs: 150, logSink: () => {} } });
  // Poll rarely so only the heartbeat refreshes the route's idle timer.
  const session = startSession(fixture, { pollIntervalMs: 10_000, heartbeatIntervalMs: 40 });
  try {
    await delay(350);
    const route = fixture.broker.resolve("demo-room");
    assert.equal(route.status, "active");
  } finally {
    await session.stop();
    await fixture.close();
  }
});
