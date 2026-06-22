import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { createRoomHttpServer } from "../src/server/index.js";
import {
  BROKER_LIMITS,
  BrokerGuards,
  createBrokerHttpServer,
  TunnelBroker,
  TunnelClient,
  TunnelError
} from "../src/tunnel/index.js";

const T0 = Date.parse("2026-06-22T00:00:00.000Z");

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

function makeClock(start: number): { now: () => number; advance: (delta: number) => void } {
  const state = { ms: start };
  return { now: () => state.ms, advance: (delta) => (state.ms += delta) };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof TunnelError && error.code === code;
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("route request concurrency limit rejects over-limit requests and recovers on release", () => {
  const guards = new BrokerGuards(() => T0, { ...BROKER_LIMITS, concurrentRequestsPerRoute: 1 });
  const input = { routeSlug: "a", clientIp: "1.1.1.1", isWait: false, authenticated: true };
  const release = guards.enter(input);
  assert.throws(() => guards.enter(input), hasCode("route_request_limit"));
  release();
  guards.enter(input)();
});

test("wait concurrency limit is enforced independently", () => {
  const guards = new BrokerGuards(() => T0, { ...BROKER_LIMITS, concurrentWaitsPerRoute: 1 });
  const input = { routeSlug: "a", clientIp: "1.1.1.1", isWait: true, authenticated: true };
  const release = guards.enter(input);
  assert.throws(() => guards.enter(input), hasCode("wait_limit"));
  release();
});

test("per-route and unauthenticated per-ip rate limits return a stable code", () => {
  const routeGuards = new BrokerGuards(() => T0, { ...BROKER_LIMITS, requestsPerRoutePerMinute: 2 });
  routeGuards.enter({ routeSlug: "a", clientIp: "ip", isWait: false, authenticated: true })();
  routeGuards.enter({ routeSlug: "a", clientIp: "ip", isWait: false, authenticated: true })();
  assert.throws(
    () => routeGuards.enter({ routeSlug: "a", clientIp: "ip", isWait: false, authenticated: true }),
    hasCode("rate_limited")
  );

  const ipGuards = new BrokerGuards(() => T0, { ...BROKER_LIMITS, unauthenticatedPerIpPerMinute: 1 });
  ipGuards.enter({ routeSlug: "a", clientIp: "ip", isWait: false, authenticated: false })();
  assert.throws(
    () => ipGuards.enter({ routeSlug: "b", clientIp: "ip", isWait: false, authenticated: false }),
    hasCode("rate_limited")
  );
});

test("a route idle-expires after the idle timeout with no activity", () => {
  const clock = makeClock(T0);
  const broker = new TunnelBroker({ now: clock.now, routeTtlMs: 1_000, maxRouteLifetimeMs: 1_000_000 });
  broker.register({ route_slug: "demo-room", target: "http://127.0.0.1:8787" });
  clock.advance(1_001);
  assert.throws(() => broker.resolve("demo-room"), hasCode("route_expired"));
});

test("a route hits the max lifetime cap even when heartbeats keep refreshing it", () => {
  const clock = makeClock(T0);
  const broker = new TunnelBroker({ now: clock.now, routeTtlMs: 10_000, maxRouteLifetimeMs: 5_000 });
  const route = broker.register({ route_slug: "demo-room", target: "http://127.0.0.1:8787" });
  clock.advance(3_000);
  broker.heartbeat({ route_id: route.route_id, host_connection_id: route.host_connection_id });
  clock.advance(3_000);
  assert.throws(() => broker.resolve("demo-room"), hasCode("route_expired"));
});

test("a request body over the limit is rejected before forwarding", async () => {
  const stdout = new Capture();
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "telegent-limit-test-")),
    stdout,
    stderr: new Capture()
  };
  const hostPort = await getFreePort();
  const hostBaseUrl = `http://127.0.0.1:${hostPort}`;
  await runRoomCommand(["start", "demo-room", "--alias", "host", "--url", hostBaseUrl, "--json"], context);
  stdout.reset();
  await runRoomCommand(["invite", "reviewer", "--kind", "agent", "--json"], context);
  const token = stdout.json<{ token: string }>().token;

  const broker = new TunnelBroker({ routeTtlMs: 60_000, limits: { requestBodyBytes: 64 }, logSink: () => {} });
  const brokerServer = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => brokerServer.listen(0, "127.0.0.1", resolve));
  const publicBaseUrl = `http://127.0.0.1:${(brokerServer.address() as AddressInfo).port}/demo-room`;
  const hostServer = createRoomHttpServer({ root: context.home, roomId: "demo-room", baseUrl: hostBaseUrl, rateLimitPerMinute: 1_000 });
  await new Promise<void>((resolve) => hostServer.listen(hostPort, "127.0.0.1", resolve));
  await new TunnelClient(`http://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`).register("demo-room", hostBaseUrl);

  try {
    const response = await fetch(`${publicBaseUrl}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(500) })
    });
    assert.equal(response.status, 413);
    assert.equal(((await response.json()) as { error: string }).error, "request_too_large");
  } finally {
    await new Promise<void>((resolve) => brokerServer.close(() => resolve()));
    await new Promise<void>((resolve) => hostServer.close(() => resolve()));
  }
});

test("an over-limit response with a known content-length is rejected with a stable error before headers", async () => {
  const hostPort = await getFreePort();
  const big = "x".repeat(5_000);
  const target = createServer((_req, res) => {
    // setHeader (not writeHead) lets res.end compute and send a content-length,
    // so the broker can reject cleanly before committing any headers.
    res.setHeader("content-type", "text/plain");
    res.end(big);
  });
  await new Promise<void>((resolve) => target.listen(hostPort, "127.0.0.1", resolve));

  const broker = new TunnelBroker({ routeTtlMs: 60_000, limits: { responseBodyBytes: 1_000 }, logSink: () => {} });
  const brokerServer = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => brokerServer.listen(0, "127.0.0.1", resolve));
  const brokerBaseUrl = `http://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`;
  await new TunnelClient(brokerBaseUrl).register("demo-room", `http://127.0.0.1:${hostPort}`);

  try {
    const response = await fetch(`${brokerBaseUrl}/demo-room/`);
    const payload = (await response.json()) as { error: string };
    assert.equal(response.status, 502);
    assert.equal(payload.error, "response_too_large");
    assert.equal(JSON.stringify(payload).includes("x".repeat(50)), false);
  } finally {
    await new Promise<void>((resolve) => brokerServer.close(() => resolve()));
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test("an over-limit streamed response with no content-length is logged as response_too_large, not a success", async () => {
  const hostPort = await getFreePort();
  const target = createServer((_req, res) => {
    // Chunked (no content-length): the cap is only hit mid-stream.
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("x".repeat(800));
    res.write("x".repeat(800));
    res.end();
  });
  await new Promise<void>((resolve) => target.listen(hostPort, "127.0.0.1", resolve));

  const records: Array<Record<string, unknown>> = [];
  const broker = new TunnelBroker({
    routeTtlMs: 60_000,
    limits: { responseBodyBytes: 1_000 },
    logSink: (record) => records.push({ ...record })
  });
  const brokerServer = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => brokerServer.listen(0, "127.0.0.1", resolve));
  const brokerBaseUrl = `http://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`;
  await new TunnelClient(brokerBaseUrl).register("demo-room", `http://127.0.0.1:${hostPort}`);

  try {
    try {
      await (await fetch(`${brokerBaseUrl}/demo-room/`)).text();
    } catch {
      // Socket destruction mid-stream is expected once headers are committed.
    }
    assert.equal(
      records.some((record) => record.error === "response_too_large"),
      true
    );
    assert.equal(
      records.some((record) => record.event === "forward" && record.status === 200),
      false
    );
    assert.equal(JSON.stringify(records).includes("x".repeat(50)), false);
  } finally {
    await new Promise<void>((resolve) => brokerServer.close(() => resolve()));
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});
