import assert from "node:assert/strict";
import test from "node:test";
import {
  derivePlatformStatus,
  routeHealthFromSignal,
  routeSignalFromMetadata,
  type HostStatusSignal,
  type RouteHealthSignal
} from "../src/platform/index.js";
import type { RouteMetadata } from "../src/tunnel/index.js";

function activeRoute(overrides: Partial<RouteHealthSignal> = {}): RouteHealthSignal {
  return { registered: true, route_status: "active", host_connected: true, ...overrides };
}

function openHost(participants: HostStatusSignal["participants"] = []): HostStatusSignal {
  return { room_status: "open", participants };
}

const REQUIRED_ATTENDING = { kind: "agent" as const, attendance_required: true, attendance_state: "attending" };
const REQUIRED_STALE = { kind: "agent" as const, attendance_required: true, attendance_state: "stale" };
const OPTIONAL_AWAY = { kind: "human" as const, attendance_required: false, attendance_state: "away" };

test("active: route active, host connected, and a required participant is attending", () => {
  const result = derivePlatformStatus(activeRoute(), openHost([REQUIRED_ATTENDING]));
  assert.equal(result.status, "active");
  assert.equal(result.reason, "foreground_attending");
  assert.deepEqual(result.route_health, { reachable: true, host_connected: true });
});

test("idle: route healthy but a required participant is not attending", () => {
  const result = derivePlatformStatus(activeRoute(), openHost([REQUIRED_STALE]));
  assert.equal(result.status, "idle");
  assert.equal(result.reason, "foreground_idle");
});

test("idle: route healthy and no foreground attendance is required", () => {
  const result = derivePlatformStatus(activeRoute(), openHost([OPTIONAL_AWAY]));
  assert.equal(result.status, "idle");
  assert.equal(result.reason, "no_foreground_required");
});

test("idle requires every required participant to attend, not just one", () => {
  const result = derivePlatformStatus(activeRoute(), openHost([REQUIRED_ATTENDING, REQUIRED_STALE]));
  assert.equal(result.status, "idle");
  assert.equal(result.reason, "foreground_idle");
});

test("paused: route active but the host is not connected (stale heartbeat)", () => {
  const result = derivePlatformStatus(activeRoute({ host_connected: false }), openHost([REQUIRED_ATTENDING]));
  assert.equal(result.status, "paused");
  assert.equal(result.reason, "host_unavailable");
  // A stale route can never read as active even with an attending participant.
  assert.notEqual(result.status, "active");
});

test("paused: no broker route is registered", () => {
  const result = derivePlatformStatus({ registered: false }, openHost([REQUIRED_ATTENDING]));
  assert.equal(result.status, "paused");
  assert.equal(result.reason, "host_unavailable");
  assert.deepEqual(result.route_health, { reachable: false, host_connected: false });
});

test("paused: an expired route is recoverable, not terminal", () => {
  const result = derivePlatformStatus(activeRoute({ route_status: "expired", host_connected: false }), openHost());
  assert.equal(result.status, "paused");
  assert.equal(result.reason, "route_expired");
});

test("closed: the broker route is explicitly closed", () => {
  const result = derivePlatformStatus(
    activeRoute({ route_status: "closed", host_connected: false }),
    openHost([REQUIRED_ATTENDING])
  );
  assert.equal(result.status, "closed");
  assert.equal(result.reason, "route_closed");
});

test("closed: the host marked the room closed even while the route is active", () => {
  const result = derivePlatformStatus(activeRoute(), { room_status: "closed", participants: [REQUIRED_ATTENDING] });
  assert.equal(result.status, "closed");
  assert.equal(result.reason, "room_closed");
});

test("route health distinguishes a registered route from an actually reachable host", () => {
  // Registered and active, but the host endpoint is not attending: reachable
  // route, unreachable host.
  assert.deepEqual(routeHealthFromSignal(activeRoute({ host_connected: false })), {
    reachable: true,
    host_connected: false
  });
  // Registered and active with an attending host: both true.
  assert.deepEqual(routeHealthFromSignal(activeRoute()), { reachable: true, host_connected: true });
  // No route at all: neither.
  assert.deepEqual(routeHealthFromSignal({ registered: false }), { reachable: false, host_connected: false });
  // Expired route is not reachable for new traffic.
  assert.deepEqual(routeHealthFromSignal(activeRoute({ route_status: "expired" })), {
    reachable: false,
    host_connected: true
  });
});

test("routeSignalFromMetadata maps broker route metadata and its absence", () => {
  assert.deepEqual(routeSignalFromMetadata(undefined), { registered: false });
  const route: RouteMetadata = {
    route_slug: "demo-room",
    route_id: "rte_1",
    host_connection_id: "conn_1",
    created_at: "2026-06-23T00:00:00.000Z",
    last_seen_at: "2026-06-23T00:00:00.000Z",
    last_heartbeat_at: "2026-06-23T00:00:00.000Z",
    expires_at: "2026-06-23T01:00:00.000Z",
    status: "active",
    host_connected: true
  };
  assert.deepEqual(routeSignalFromMetadata(route), {
    registered: true,
    route_status: "active",
    host_connected: true
  });
});

test("derivation reads only route and attendance metadata, never message content", () => {
  // The signal types carry no message, body, brief, or token fields; passing a
  // fully-populated active case still yields only status/reason/route_health.
  const result = derivePlatformStatus(activeRoute(), openHost([REQUIRED_ATTENDING]));
  assert.deepEqual(Object.keys(result).sort(), ["reason", "route_health", "status"]);
  assert.doesNotMatch(JSON.stringify(result), /Bearer|tgl_|message|brief/);
});
