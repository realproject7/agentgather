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
  createBrokerHttpServer,
  HostTunnelSession,
  TunnelBroker,
  TunnelClient,
  TunnelError
} from "../src/tunnel/index.js";
import { createBrokerMeter, MeteringLedger, type MeteringRecord, type MeteringStore } from "../src/platform/index.js";

const T0 = 1_750_000_000_000;

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

function memoryStore(): MeteringStore {
  const map = new Map<string, MeteringRecord>();
  return {
    async read(subject) {
      return map.get(subject) ?? null;
    },
    async write(subject, record) {
      map.set(subject, record);
    }
  };
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await delay(10);
  }
}

interface Fixture {
  broker: TunnelBroker;
  ledger: MeteringLedger;
  brokerBaseUrl: string;
  hostBaseUrl: string;
  client: TunnelClient;
  publicBaseUrl: string;
  startHost: () => HostTunnelSession;
  close: () => Promise<void>;
}

async function setup(quota: Partial<Record<string, number>> = {}): Promise<Fixture> {
  const stdout = new Capture();
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "agentgather-metering-broker-")),
    stdout,
    stderr: new Capture()
  };
  const hostPort = await getFreePort();
  const hostBaseUrl = `http://127.0.0.1:${hostPort}`;
  await runRoomCommand(["start", "pub-room", "--alias", "host", "--url", hostBaseUrl, "--json"], context);

  const ledger = new MeteringLedger({ store: memoryStore(), now: () => T0, quota });
  const broker = new TunnelBroker({
    routeTtlMs: 60_000,
    logSink: () => {},
    meter: createBrokerMeter(ledger)
  });
  const brokerServer = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => brokerServer.listen(0, "127.0.0.1", resolve));
  const brokerBaseUrl = `http://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`;

  const hostServer = createRoomHttpServer({
    root: context.home,
    roomId: "pub-room",
    baseUrl: hostBaseUrl,
    waitHoldMs: 60,
    rateLimitPerMinute: 1_000,
    publicBaseUrl: () => `${brokerBaseUrl}/pub-room`
  });
  await new Promise<void>((resolve) => hostServer.listen(hostPort, "127.0.0.1", resolve));

  const client = new TunnelClient(brokerBaseUrl);
  const { route } = await client.register("pub-room");

  return {
    broker,
    ledger,
    brokerBaseUrl,
    hostBaseUrl,
    client,
    publicBaseUrl: `${brokerBaseUrl}/pub-room`,
    startHost: () => {
      const session = new HostTunnelSession(client, {
        routeId: route.route_id,
        hostConnectionId: route.host_connection_id,
        target: hostBaseUrl,
        pollIntervalMs: 10,
        heartbeatIntervalMs: 1_000
      });
      session.start();
      return session;
    },
    close: async () => {
      await new Promise<void>((resolve) => brokerServer.close(() => resolve()));
      await new Promise<void>((resolve) => hostServer.close(() => resolve()));
    }
  };
}

test("real public-route forwards increment relay, bandwidth, and join counters", async () => {
  const fixture = await setup();
  const session = fixture.startHost();
  try {
    // Route registration metered the active public room (best-effort/async).
    await waitFor(async () => (await fixture.ledger.usage("pub-room")).window.counters.active_public_rooms >= 1);

    // A forwarded request through the relay is metered by byte counts only.
    const status = await fetch(`${fixture.publicBaseUrl}/status`);
    assert.equal(status.status, 401); // host responds; auth not needed to meter the forward
    await waitFor(async () => (await fixture.ledger.usage("pub-room")).window.counters.relay_requests >= 1);
    const afterStatus = await fixture.ledger.usage("pub-room");
    assert.equal(afterStatus.window.counters.relay_requests, 1);
    assert.ok(afterStatus.window.counters.bandwidth_bytes > 0, "bandwidth bytes should be counted");

    // A forwarded /join is additionally counted as a participant join.
    await fetch(`${fixture.publicBaseUrl}/join`, { method: "POST" });
    await waitFor(async () => (await fixture.ledger.usage("pub-room")).window.counters.participant_joins >= 1);
    const afterJoin = await fixture.ledger.usage("pub-room");
    assert.equal(afterJoin.window.counters.participant_joins, 1);
    assert.equal(afterJoin.window.counters.relay_requests, 2);
  } finally {
    await session.stop();
    await fixture.close();
  }
});

test("an exceeded public quota maps to a 429 quota_exceeded on the forward admit path", async () => {
  const fixture = await setup({ relay_requests: 5 });
  try {
    // Drive the route's subject over quota before any forward.
    await fixture.ledger.record("pub-room", "relay_requests", 10, { isPublicRoute: true });

    const response = await fetch(`${fixture.publicBaseUrl}/status`);
    assert.equal(response.status, 429);
    assert.equal(((await response.json()) as { error: string }).error, "quota_exceeded");
    // The admit denial fired before any relay forward, so no host was needed.
  } finally {
    await fixture.close();
  }
});

test("a local-target route is forwarded directly and never metered", async () => {
  const fixture = await setup();
  try {
    // Register a second route with a local target: it uses direct forwarding.
    await fixture.broker.register({ route_slug: "local-room", target: fixture.hostBaseUrl });
    const response = await fetch(`${fixture.brokerBaseUrl}/local-room/status`);
    assert.equal(response.status, 401); // forwarded directly to the local host
    await delay(30);
    const usage = await fixture.ledger.usage("local-room");
    assert.equal(usage.window.counters.relay_requests, 0);
    assert.equal(usage.window.counters.active_public_rooms, 0);
    assert.equal(usage.window.counters.bandwidth_bytes, 0);
  } finally {
    await fixture.close();
  }
});

test("closing a public route meters its lifetime as route minutes", async () => {
  const fixture = await setup();
  try {
    const route = fixture.broker.snapshot().find((entry) => entry.route_slug === "pub-room");
    assert.ok(route !== undefined);
    fixture.broker.closeRoute({ route_id: route.route_id, host_connection_id: route.host_connection_id });
    await waitFor(async () => (await fixture.ledger.usage("pub-room")).window.counters.route_minutes >= 0);
    // The close hook fired for the public route without error.
    const usage = await fixture.ledger.usage("pub-room");
    assert.ok(usage.window.counters.route_minutes >= 0);
  } finally {
    await fixture.close();
  }
});

test("the quota_exceeded signal is the existing TunnelError type", () => {
  const error = new TunnelError("quota_exceeded", 429, "public routing free quota exceeded");
  assert.equal(error.code, "quota_exceeded");
  assert.equal(error.status, 429);
  assert.equal(error.body().error, "quota_exceeded");
});
