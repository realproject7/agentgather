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
import { createBrokerHttpServer, TunnelBroker, TunnelClient } from "../src/tunnel/index.js";

class Capture extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    callback();
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

interface Fixture {
  publicBaseUrl: string;
  hostToken: string;
  reviewerToken: string;
  broker: TunnelBroker;
  fetchThroughBroker: (path: string, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

async function setup(): Promise<Fixture> {
  const stdout = new Capture();
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "agentgather-fwd-test-")),
    stdout,
    stderr: new Capture()
  };
  const hostPort = await getFreePort();
  const hostBaseUrl = `http://127.0.0.1:${hostPort}`;

  await runRoomCommand(
    ["start", "demo-room", "--alias", "host", "--brief", "Ship it.", "--url", hostBaseUrl, "--json"],
    context
  );
  const hostToken = stdout.json<{ token: string }>().token;
  stdout.reset();
  await runRoomCommand(["invite", "reviewer", "--kind", "agent", "--json"], context);
  const reviewerToken = stdout.json<{ token: string }>().token;

  const broker = new TunnelBroker({ routeTtlMs: 60_000 });
  const brokerServer = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => brokerServer.listen(0, "127.0.0.1", resolve));
  const brokerBaseUrl = `http://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`;
  const publicBaseUrl = `${brokerBaseUrl}/my-room`;

  const hostServer = createRoomHttpServer({
    root: context.home,
    roomId: "demo-room",
    baseUrl: hostBaseUrl,
    waitHoldMs: 80,
    rateLimitPerMinute: 1_000,
    publicBaseUrl: () => publicBaseUrl
  });
  await new Promise<void>((resolve) => hostServer.listen(hostPort, "127.0.0.1", resolve));

  await new TunnelClient(brokerBaseUrl).register("my-room", hostBaseUrl);

  return {
    publicBaseUrl,
    hostToken,
    reviewerToken,
    broker,
    fetchThroughBroker: (p, init) => fetch(`${publicBaseUrl}${p}`, init),
    close: async () => {
      await new Promise<void>((resolve) => brokerServer.close(() => resolve()));
      await new Promise<void>((resolve) => hostServer.close(() => resolve()));
    }
  };
}

test("broker forwards GET /card and renders the broker public URL", async () => {
  const fixture = await setup();
  try {
    const response = await fixture.fetchThroughBroker(`/card?participant=reviewer&token=${fixture.reviewerToken}`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(text.includes(`${fixture.publicBaseUrl}/wait`), true);
    assert.equal(text.includes(`${fixture.publicBaseUrl}/messages`), true);
  } finally {
    await fixture.close();
  }
});

test("broker forwards browser shell and assets", async () => {
  const fixture = await setup();
  try {
    const shell = await fixture.fetchThroughBroker("/");
    const shellText = await shell.text();
    assert.equal(shell.status, 200);
    assert.match(shellText, /Agent Gather Room/);
    assert.match(shellText, /src="room\.js"/);

    const css = await fixture.fetchThroughBroker("/room.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const js = await fixture.fetchThroughBroker("/room.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
  } finally {
    await fixture.close();
  }
});

test("host derives sender identity from the token; broker never honors a client-supplied from", async () => {
  const fixture = await setup();
  try {
    const response = await fixture.fetchThroughBroker("/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.reviewerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "@host hello", from: "imposter" })
    });
    const payload = (await response.json()) as { message: { from: string } };
    assert.equal(response.status, 201);
    assert.equal(payload.message.from, "reviewer");
  } finally {
    await fixture.close();
  }
});

test("remote POST with a broker origin passes the host same-origin protection", async () => {
  const fixture = await setup();
  try {
    const brokerOrigin = new URL(fixture.publicBaseUrl).origin;
    const response = await fixture.fetchThroughBroker("/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.reviewerToken}`,
        "Content-Type": "application/json",
        Origin: brokerOrigin
      },
      body: JSON.stringify({ text: "@host through the tunnel" })
    });
    assert.equal(response.status, 201);
  } finally {
    await fixture.close();
  }
});

test("broker forwards /wait heartbeat with broker public URL in next_cmd", async () => {
  const fixture = await setup();
  try {
    const response = await fixture.fetchThroughBroker("/wait?participant=reviewer&since_id=0", {
      headers: { Authorization: `Bearer ${fixture.reviewerToken}` }
    });
    const payload = (await response.json()) as { heartbeat: boolean; next_cmd: string };
    assert.equal(payload.heartbeat, true);
    assert.equal(payload.next_cmd.includes(`${fixture.publicBaseUrl}/wait`), true);
  } finally {
    await fixture.close();
  }
});

test("a held /wait releases when the room closes through the broker", async () => {
  const fixture = await setup();
  try {
    const held = fixture.fetchThroughBroker("/wait?participant=reviewer&since_id=999", {
      headers: { Authorization: `Bearer ${fixture.reviewerToken}` }
    });
    setTimeout(() => {
      void fixture.fetchThroughBroker("/close", {
        method: "POST",
        headers: { Authorization: `Bearer ${fixture.hostToken}`, "Content-Type": "application/json" }
      });
    }, 10);
    const payload = (await (await held).json()) as { room_status: string; keep_waiting: boolean };
    assert.equal(payload.room_status, "closed");
    assert.equal(payload.keep_waiting, false);
  } finally {
    await fixture.close();
  }
});

test("unsupported forwarded paths return the host 404 without leaking route metadata", async () => {
  const fixture = await setup();
  try {
    const response = await fixture.fetchThroughBroker("/does-not-exist");
    const text = await response.text();
    assert.equal(response.status, 404);
    assert.equal(/host_connection_id|route_id|conn_|rte_/.test(text), false);
  } finally {
    await fixture.close();
  }
});

test("the broker stores no room data while forwarding", async () => {
  const fixture = await setup();
  try {
    await fixture.fetchThroughBroker("/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.reviewerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "@host stored nowhere" })
    });
    const stored = fixture.broker.snapshot();
    assert.equal(stored.length, 1);
    assert.deepEqual(Object.keys(stored[0] ?? {}).sort(), [
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
  } finally {
    await fixture.close();
  }
});

test("requests to an unknown slug return route_not_found", async () => {
  const fixture = await setup();
  try {
    const brokerOrigin = new URL(fixture.publicBaseUrl).origin;
    const response = await fetch(`${brokerOrigin}/missing-room/status`);
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { error: string }).error, "route_not_found");
  } finally {
    await fixture.close();
  }
});
