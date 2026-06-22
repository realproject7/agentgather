import assert from "node:assert/strict";
import test from "node:test";
import {
  redactHeaders,
  TunnelError,
  type ForwardedRequest,
  type ForwardedResponse,
  type RouteMetadata
} from "../src/tunnel/index.js";

test("redactHeaders strips credential headers and keeps the rest", () => {
  const input = {
    Authorization: "Bearer secret-token",
    Cookie: "session=secret",
    "Proxy-Authorization": "Basic secret",
    "Content-Type": "application/json",
    "X-Request-Id": "req-1"
  };
  const safe = redactHeaders(input);

  assert.deepEqual(safe, {
    "Content-Type": "application/json",
    "X-Request-Id": "req-1"
  });
  // The original map is untouched, so callers keep what they need to forward.
  assert.equal(input.Authorization, "Bearer secret-token");
});

test("redactHeaders matches header names case-insensitively", () => {
  const safe = redactHeaders({ AUTHORIZATION: "Bearer x", cookie: "a=b", accept: "*/*" });
  assert.deepEqual(safe, { accept: "*/*" });
});

test("TunnelError exposes a stable code, status, and structured body", () => {
  const error = new TunnelError("route_not_found", 404, "no route is registered for this slug");

  assert.equal(error.code, "route_not_found");
  assert.equal(error.status, 404);
  assert.deepEqual(error.body(), {
    ok: false,
    error: "route_not_found",
    message: "no route is registered for this slug"
  });
});

test("tunnel error messages never echo URLs or tokens", () => {
  const error = new TunnelError("route_closed", 410, "this route has been closed");
  assert.equal(/https?:\/\//.test(error.message), false);
  assert.equal(/token|bearer|authorization/i.test(error.message), false);
});

test("forwarded envelopes carry opaque base64 bodies that round-trip as JSON", () => {
  const request: ForwardedRequest = {
    route_slug: "demo-room",
    method: "POST",
    path: "/messages",
    headers: { "Content-Type": "application/json" },
    body_base64: Buffer.from('{"text":"hello"}').toString("base64")
  };
  const response: ForwardedResponse = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body_base64: Buffer.from('{"ok":true}').toString("base64")
  };

  const decodedRequest = JSON.parse(JSON.stringify(request)) as ForwardedRequest;
  const decodedResponse = JSON.parse(JSON.stringify(response)) as ForwardedResponse;

  assert.equal(decodedRequest.route_slug, "demo-room");
  assert.equal(
    Buffer.from(decodedRequest.body_base64 ?? "", "base64").toString("utf8"),
    '{"text":"hello"}'
  );
  assert.equal(
    Buffer.from(decodedResponse.body_base64 ?? "", "base64").toString("utf8"),
    '{"ok":true}'
  );
});

test("route metadata exposes only ephemeral fields", () => {
  const route: RouteMetadata = {
    route_slug: "demo-room",
    route_id: "rte_sample",
    host_connection_id: "conn_sample",
    created_at: "2026-06-22T00:00:00.000Z",
    last_seen_at: "2026-06-22T00:00:00.000Z",
    expires_at: "2026-06-22T00:00:30.000Z",
    status: "active"
  };

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
