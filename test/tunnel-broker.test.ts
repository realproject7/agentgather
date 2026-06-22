import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import test from "node:test";
import {
  createBrokerHttpServer,
  TunnelBroker,
  TunnelError,
  type RouteMetadata
} from "../src/tunnel/index.js";

const T0 = Date.parse("2026-06-22T00:00:00.000Z");

function makeClock(start: number): { now: () => number; advance: (delta: number) => void } {
  const state = { ms: start };
  return {
    now: () => state.ms,
    advance: (delta: number) => {
      state.ms += delta;
    }
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof TunnelError && error.code === code;
}

async function startListener(broker: TunnelBroker): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createBrokerHttpServer(broker);
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

test("register returns active route metadata with minted identifiers", () => {
  const clock = makeClock(T0);
  const broker = new TunnelBroker({ now: clock.now, routeTtlMs: 1_000 });

  const route = broker.register({ route_slug: "demo-room" });

  assert.equal(route.route_slug, "demo-room");
  assert.equal(route.status, "active");
  assert.match(route.route_id, /^rte_/);
  assert.match(route.host_connection_id, /^conn_/);
  assert.equal(route.created_at, "2026-06-22T00:00:00.000Z");
  assert.equal(route.last_seen_at, "2026-06-22T00:00:00.000Z");
  assert.equal(route.expires_at, "2026-06-22T00:00:01.000Z");
});

test("register rejects a malformed slug with a stable code", () => {
  const broker = new TunnelBroker();
  assert.throws(() => broker.register({ route_slug: "Not A Slug" }), hasCode("invalid_registration"));
});

test("register rejects a duplicate active slug", () => {
  const broker = new TunnelBroker({ now: makeClock(T0).now });
  broker.register({ route_slug: "demo-room" });
  assert.throws(() => broker.register({ route_slug: "demo-room" }), hasCode("route_slug_taken"));
});

test("heartbeat refreshes last-seen and expiry", () => {
  const clock = makeClock(T0);
  const broker = new TunnelBroker({ now: clock.now, routeTtlMs: 1_000 });
  const route = broker.register({ route_slug: "demo-room" });

  clock.advance(500);
  const refreshed = broker.heartbeat({
    route_id: route.route_id,
    host_connection_id: route.host_connection_id
  });

  assert.equal(refreshed.last_seen_at, "2026-06-22T00:00:00.500Z");
  assert.equal(refreshed.expires_at, "2026-06-22T00:00:01.500Z");
  assert.equal(refreshed.status, "active");
});

test("heartbeat with unknown identifiers is rejected", () => {
  const broker = new TunnelBroker();
  broker.register({ route_slug: "demo-room" });
  assert.throws(
    () => broker.heartbeat({ route_id: "rte_nope", host_connection_id: "conn_nope" }),
    hasCode("route_not_found")
  );
});

test("a route expires once its TTL elapses without a heartbeat", () => {
  const clock = makeClock(T0);
  const broker = new TunnelBroker({ now: clock.now, routeTtlMs: 1_000 });
  const route = broker.register({ route_slug: "demo-room" });

  clock.advance(1_001);

  assert.throws(() => broker.resolve("demo-room"), hasCode("route_expired"));
  assert.throws(
    () => broker.heartbeat({ route_id: route.route_id, host_connection_id: route.host_connection_id }),
    hasCode("route_expired")
  );
  assert.equal(broker.snapshot()[0]?.status, "expired");
});

test("closing a route blocks resolution and heartbeats but frees the slug", () => {
  const broker = new TunnelBroker({ now: makeClock(T0).now, routeTtlMs: 5_000 });
  const route = broker.register({ route_slug: "demo-room" });

  const closed = broker.closeRoute({
    route_id: route.route_id,
    host_connection_id: route.host_connection_id
  });
  assert.deepEqual(closed, { ok: true, route_slug: "demo-room", status: "closed" });

  assert.throws(() => broker.resolve("demo-room"), hasCode("route_closed"));
  assert.throws(
    () => broker.heartbeat({ route_id: route.route_id, host_connection_id: route.host_connection_id }),
    hasCode("route_closed")
  );

  // The slug is free again after close, so the host can re-register.
  const reopened = broker.register({ route_slug: "demo-room" });
  assert.equal(reopened.status, "active");
  assert.notEqual(reopened.route_id, route.route_id);
});

test("close with mismatched identifiers is rejected", () => {
  const broker = new TunnelBroker();
  broker.register({ route_slug: "demo-room" });
  assert.throws(
    () => broker.closeRoute({ route_id: "rte_nope", host_connection_id: "conn_nope" }),
    hasCode("route_not_found")
  );
});

test("the broker stores only ephemeral route metadata", () => {
  const broker = new TunnelBroker({ now: makeClock(T0).now });
  broker.register({ route_slug: "demo-room" });

  const stored = broker.snapshot();
  assert.equal(stored.length, 1);
  const route = stored[0] as RouteMetadata;
  assert.deepEqual(Object.keys(route).sort(), [
    "created_at",
    "expires_at",
    "host_connection_id",
    "last_seen_at",
    "route_id",
    "route_slug",
    "status"
  ]);
});

test("listener returns route status for an active slug", async () => {
  const broker = new TunnelBroker({ routeTtlMs: 30_000 });
  broker.register({ route_slug: "demo-room" });
  const listener = await startListener(broker);
  try {
    const response = await fetch(`${listener.baseUrl}/demo-room`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, route_slug: "demo-room", status: "active" });
  } finally {
    await listener.close();
  }
});

test("listener returns stable errors for unsupported, unknown, closed, and expired routes", async () => {
  const clock = makeClock(T0);
  const broker = new TunnelBroker({ now: clock.now, routeTtlMs: 1_000 });
  const listener = await startListener(broker);
  try {
    const root = await fetch(`${listener.baseUrl}/`);
    assert.equal(root.status, 404);
    assert.equal((await root.json()).error, "unsupported_route");

    const unknown = await fetch(`${listener.baseUrl}/missing-room`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, "route_not_found");

    const route = broker.register({ route_slug: "demo-room" });
    broker.closeRoute({ route_id: route.route_id, host_connection_id: route.host_connection_id });
    const closed = await fetch(`${listener.baseUrl}/demo-room`);
    assert.equal(closed.status, 410);
    assert.equal((await closed.json()).error, "route_closed");

    broker.register({ route_slug: "live-room" });
    clock.advance(1_001);
    const expired = await fetch(`${listener.baseUrl}/live-room`);
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).error, "route_expired");
  } finally {
    await listener.close();
  }
});
