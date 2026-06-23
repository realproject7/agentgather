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
  type ForwardedResponse,
  TunnelBroker,
  TunnelClient,
  TunnelError
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
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
  records: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

async function setup(options: { claimTimeoutMs?: number } = {}): Promise<Fixture> {
  const stdout = new Capture();
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "agentgather-relay-test-")),
    stdout,
    stderr: new Capture()
  };
  const hostPort = await getFreePort();
  const hostBaseUrl = `http://127.0.0.1:${hostPort}`;

  await runRoomCommand(["start", "demo-room", "--alias", "host", "--brief", "Relay it.", "--url", hostBaseUrl, "--json"], context);
  const hostToken = stdout.json<{ token: string }>().token;
  stdout.reset();
  await runRoomCommand(["invite", "reviewer", "--kind", "agent", "--json"], context);
  const reviewerToken = stdout.json<{ token: string }>().token;

  const records: Array<Record<string, unknown>> = [];
  const broker = new TunnelBroker({
    routeTtlMs: 60_000,
    claimTimeoutMs: options.claimTimeoutMs ?? 5_000,
    responseTimeoutMs: 30_000,
    logSink: (record) => records.push({ ...record })
  });
  const brokerServer = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => brokerServer.listen(0, "127.0.0.1", resolve));
  const brokerBaseUrl = `http://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`;
  const publicBaseUrl = `${brokerBaseUrl}/demo-room`;

  const hostServer = createRoomHttpServer({
    root: context.home,
    roomId: "demo-room",
    baseUrl: hostBaseUrl,
    waitHoldMs: 60,
    rateLimitPerMinute: 1_000,
    publicBaseUrl: () => publicBaseUrl
  });
  await new Promise<void>((resolve) => hostServer.listen(hostPort, "127.0.0.1", resolve));

  // Register WITHOUT a target: managed relay mode, the broker stores no target.
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
    records,
    close: async () => {
      await new Promise<void>((resolve) => brokerServer.close(() => resolve()));
      await new Promise<void>((resolve) => hostServer.close(() => resolve()));
    }
  };
}

function startAttendant(fixture: Fixture): () => Promise<void> {
  let running = true;
  const loop = (async () => {
    while (running) {
      let handled = false;
      try {
        handled = await fixture.client.attendOnce(fixture.routeId, fixture.hostConnectionId, fixture.hostBaseUrl);
      } catch {
        handled = false;
      }
      if (!handled) await delay(3);
    }
  })();
  return async () => {
    running = false;
    await loop;
  };
}

test("the broker stores no target and relays requests through a host attendant", async () => {
  const fixture = await setup();
  const stop = startAttendant(fixture);
  try {
    assert.equal(fixture.broker.target("demo-room"), undefined);

    const card = await fetch(`${fixture.publicBaseUrl}/card?participant=reviewer&token=${fixture.reviewerToken}`);
    const cardText = await card.text();
    assert.equal(card.status, 200);
    assert.match(cardText, /Relay it\./);
    assert.equal(cardText.includes(`${fixture.publicBaseUrl}/messages`), true);

    const joined = await fetch(`${fixture.publicBaseUrl}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.reviewerToken}` }
    });
    assert.equal(joined.status, 200);

    const sent = await fetch(`${fixture.publicBaseUrl}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.reviewerToken}`, "Content-Type": "application/json", Origin: new URL(fixture.publicBaseUrl).origin },
      body: JSON.stringify({ text: "@host relayed", from: "imposter" })
    });
    const sentBody = (await sent.json()) as { message: { from: string } };
    assert.equal(sent.status, 201);
    assert.equal(sentBody.message.from, "reviewer");

    const shell = await fetch(`${fixture.publicBaseUrl}/`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /Agent Gather Room/);

    const wait = await fetch(`${fixture.publicBaseUrl}/wait?participant=reviewer&since_id=999`, {
      headers: { Authorization: `Bearer ${fixture.reviewerToken}` }
    });
    const waitBody = (await wait.json()) as { heartbeat: boolean; next_cmd: string };
    assert.equal(waitBody.heartbeat, true);
    assert.equal(waitBody.next_cmd.includes(`${fixture.publicBaseUrl}/wait`), true);

    // Broker snapshot still holds only route metadata; logs carry no secrets.
    assert.deepEqual(Object.keys(fixture.broker.snapshot()[0] ?? {}).sort(), [
      "created_at",
      "expires_at",
      "host_connected",
      "host_connection_id",
      "last_heartbeat_at",
      "last_seen_at",
      "route_id",
      "route_slug",
      "status"
    ]);
    const logs = JSON.stringify(fixture.records);
    for (const secret of [fixture.reviewerToken, "Relay it.", "relayed", "token=", "Authorization", "Bearer"]) {
      assert.equal(logs.includes(secret), false, `log leaked: ${secret}`);
    }
  } finally {
    await stop();
    await fixture.close();
  }
});

test("a request fails with host_unavailable when no host is attending", async () => {
  const fixture = await setup({ claimTimeoutMs: 80 });
  try {
    const response = await fetch(`${fixture.publicBaseUrl}/status`, {
      headers: { Authorization: `Bearer ${fixture.reviewerToken}` }
    });
    assert.equal(response.status, 504);
    assert.equal(((await response.json()) as { error: string }).error, "host_unavailable");
  } finally {
    await fixture.close();
  }
});

test("pending relay requests fail with route_closed when the route closes", async () => {
  const fixture = await setup();
  try {
    const pending = fetch(`${fixture.publicBaseUrl}/status`, {
      headers: { Authorization: `Bearer ${fixture.reviewerToken}` }
    });
    await delay(20);
    await fixture.client.close(fixture.routeId, fixture.hostConnectionId);
    const response = await pending;
    assert.equal(response.status, 410);
    assert.equal(((await response.json()) as { error: string }).error, "route_closed");
  } finally {
    await fixture.close();
  }
});

test("a duplicate response for the same request id is rejected", async () => {
  const fixture = await setup();
  try {
    const pending = fetch(`${fixture.publicBaseUrl}/status`, {
      headers: { Authorization: `Bearer ${fixture.reviewerToken}` }
    });
    await delay(20);
    const claimed = await fixture.client.poll(fixture.routeId, fixture.hostConnectionId);
    assert.notEqual(claimed, null);
    const response: ForwardedResponse = {
      status: 200,
      headers: { "content-type": "application/json" },
      body_base64: Buffer.from('{"ok":true}').toString("base64")
    };
    await fixture.client.respond(fixture.routeId, fixture.hostConnectionId, claimed?.request_id ?? "", response);
    await (await pending).text();

    await assert.rejects(
      fixture.client.respond(fixture.routeId, fixture.hostConnectionId, claimed?.request_id ?? "", response),
      (error: unknown) => error instanceof TunnelError && error.code === "unknown_request"
    );
  } finally {
    await fixture.close();
  }
});

test("a forwarded request fails fast once the host disconnects past the grace window", async () => {
  const broker = new TunnelBroker({ hostGraceMs: 60, routeTtlMs: 60_000, claimTimeoutMs: 5_000, logSink: () => {} });
  const server = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new TunnelClient(base).register("demo-room");
  try {
    await delay(150);
    const started = Date.now();
    const response = await fetch(`${base}/demo-room/status`, { headers: { Authorization: "Bearer reviewer-token" } });
    assert.equal(response.status, 504);
    assert.equal(((await response.json()) as { error: string }).error, "host_unavailable");
    // Resolved well under the 5s claim timeout: it fast-failed, not hung.
    assert.equal(Date.now() - started < 1_000, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a bare route probe reports host disconnection truthfully", async () => {
  const broker = new TunnelBroker({ hostGraceMs: 60, routeTtlMs: 60_000, logSink: () => {} });
  const server = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new TunnelClient(base).register("demo-room");
  try {
    const connected = (await (await fetch(`${base}/demo-room`)).json()) as { status: string; host_connected: boolean };
    assert.equal(connected.status, "active");
    assert.equal(connected.host_connected, true);

    await delay(150);
    const disconnected = (await (await fetch(`${base}/demo-room`)).json()) as { status: string; host_connected: boolean };
    assert.equal(disconnected.status, "active");
    assert.equal(disconnected.host_connected, false);

    const missing = await fetch(`${base}/never-registered`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: string }).error, "route_not_found");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an over-limit relay request body is rejected before it is queued", async () => {
  const stdout = new Capture();
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "agentgather-relay-body-")),
    stdout,
    stderr: new Capture()
  };
  await runRoomCommand(["start", "demo-room", "--alias", "host", "--json"], context);
  stdout.reset();
  await runRoomCommand(["invite", "reviewer", "--kind", "agent", "--json"], context);
  const token = stdout.json<{ token: string }>().token;

  const broker = new TunnelBroker({ routeTtlMs: 60_000, limits: { requestBodyBytes: 64 }, logSink: () => {} });
  const brokerServer = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => brokerServer.listen(0, "127.0.0.1", resolve));
  const brokerBaseUrl = `http://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`;
  await new TunnelClient(brokerBaseUrl).register("demo-room");

  try {
    const response = await fetch(`${brokerBaseUrl}/demo-room/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(500) })
    });
    assert.equal(response.status, 413);
    assert.equal(((await response.json()) as { error: string }).error, "request_too_large");
  } finally {
    await new Promise<void>((resolve) => brokerServer.close(() => resolve()));
  }
});

test("an over-limit relay response body is rejected with response_too_large", async () => {
  const stdout = new Capture();
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "agentgather-relay-resp-")),
    stdout,
    stderr: new Capture()
  };
  await runRoomCommand(["start", "demo-room", "--alias", "host", "--json"], context);

  const broker = new TunnelBroker({ routeTtlMs: 60_000, limits: { responseBodyBytes: 100 }, logSink: () => {} });
  const brokerServer = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => brokerServer.listen(0, "127.0.0.1", resolve));
  const brokerBaseUrl = `http://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`;
  const client = new TunnelClient(brokerBaseUrl);
  const { route } = await client.register("demo-room");

  try {
    const pending = fetch(`${brokerBaseUrl}/demo-room/`);
    await delay(20);
    const claimed = await client.poll(route.route_id, route.host_connection_id);
    const oversize: ForwardedResponse = {
      status: 200,
      headers: { "content-type": "text/plain" },
      body_base64: Buffer.from("x".repeat(5_000)).toString("base64")
    };
    await assert.rejects(
      client.respond(route.route_id, route.host_connection_id, claimed?.request_id ?? "", oversize),
      (error: unknown) => error instanceof TunnelError && error.code === "response_too_large"
    );
    const response = await pending;
    assert.equal(response.status, 502);
    assert.equal(((await response.json()) as { error: string }).error, "response_too_large");
  } finally {
    await new Promise<void>((resolve) => brokerServer.close(() => resolve()));
  }
});
