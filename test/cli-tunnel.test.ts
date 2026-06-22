import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { runTunnelCommand } from "../src/cli/commands/tunnel/index.js";
import { readCurrent, writeCurrent } from "../src/cli/state.js";
import { createRoomHttpServer } from "../src/server/index.js";
import {
  createBrokerHttpServer,
  readPublicBaseUrl,
  TunnelBroker,
  TunnelClient
} from "../src/tunnel/index.js";

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

  reset(): void {
    this.chunks = [];
  }
}

async function makeContext(): Promise<{ context: CliContext; stdout: Capture; stderr: Capture }> {
  const stdout = new Capture();
  const stderr = new Capture();
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "telegent-tunnel-test-")),
    stdout,
    stderr
  };
  return { context, stdout, stderr };
}

async function startBroker(broker: TunnelBroker): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

async function startRoomServer(
  home: string,
  roomId: string,
  localBaseUrl: string
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createRoomHttpServer({
    root: home,
    roomId,
    baseUrl: localBaseUrl,
    waitHoldMs: 50,
    publicBaseUrl: () => readPublicBaseUrl(home, roomId) ?? localBaseUrl
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

test("tunnel start publishes the broker URL into room state, invite cards, /card, and /wait.next_cmd", async () => {
  const { context, stdout } = await makeContext();
  const broker = await startBroker(new TunnelBroker({ routeTtlMs: 60_000 }));
  try {
    await runRoomCommand(["start", "demo-room", "--alias", "host", "--brief", "Ship it.", "--json"], context);

    stdout.reset();
    await runRoomCommand(["invite", "reviewer", "--kind", "agent", "--json"], context);
    const invite = stdout.json<{ token: string }>();

    stdout.reset();
    await runTunnelCommand(
      ["start", "--room", "current", "--broker", broker.baseUrl, "--subdomain", "my-room", "--json"],
      context
    );
    const published = stdout.json<{ ok: true; public_base_url: string; route_slug: string; warning: string }>();
    const publicBaseUrl = `${broker.baseUrl}/my-room`;
    assert.equal(published.public_base_url, publicBaseUrl);
    assert.equal(published.route_slug, "my-room");
    assert.match(published.warning, /localhost/i);

    // Current room state now points at the broker public URL.
    stdout.reset();
    await runRoomCommand(["current", "--json"], context);
    const current = stdout.json<{ current: { baseUrl: string } }>();
    assert.equal(current.current.baseUrl, publicBaseUrl);

    // CLI-rendered invite card uses the broker URL.
    stdout.reset();
    await runRoomCommand(["invite-card", "reviewer"], context);
    const card = stdout.text();
    assert.equal(card.includes(`${publicBaseUrl}/card`), true);
    assert.equal(card.includes(`${publicBaseUrl}/wait`), true);

    // Server-rendered /card and /wait.next_cmd also use the broker URL.
    const roomServer = await startRoomServer(context.home, "demo-room", "http://127.0.0.1:8787");
    try {
      const cardResponse = await fetch(`${roomServer.baseUrl}/card?participant=reviewer&token=${invite.token}`);
      const cardText = await cardResponse.text();
      assert.equal(cardResponse.status, 200);
      assert.equal(cardText.includes(`${publicBaseUrl}/card`), true);
      assert.equal(cardText.includes("8787"), false);

      const waitResponse = await fetch(`${roomServer.baseUrl}/wait?participant=reviewer&since_id=0`, {
        headers: { Authorization: `Bearer ${invite.token}` }
      });
      const wait = (await waitResponse.json()) as { heartbeat: boolean; next_cmd: string };
      assert.equal(wait.heartbeat, true);
      assert.equal(wait.next_cmd.includes(`${publicBaseUrl}/wait`), true);
      assert.equal(wait.next_cmd.includes("8787"), false);
    } finally {
      await roomServer.close();
    }
  } finally {
    await broker.close();
  }
});

test("invite output keeps the broker URL after room serve rewrites current state", async () => {
  const { context, stdout } = await makeContext();
  const broker = await startBroker(new TunnelBroker({ routeTtlMs: 60_000 }));
  try {
    await runRoomCommand(["start", "demo-room", "--alias", "host", "--json"], context);
    await runRoomCommand(["invite", "reviewer", "--kind", "agent", "--json"], context);
    await runTunnelCommand(["start", "--broker", broker.baseUrl, "--subdomain", "my-room", "--json"], context);
    const publicBaseUrl = `${broker.baseUrl}/my-room`;

    // Simulate `room serve` (re)starting after registration: it rewrites
    // current.baseUrl to the local serve URL, while tunnel.json still holds the
    // published broker URL.
    const current = await readCurrent(context.home);
    await writeCurrent(context.home, { ...current, baseUrl: "http://127.0.0.1:8787" });

    stdout.reset();
    await runRoomCommand(["invite-card", "reviewer"], context);
    const card = stdout.text();
    assert.equal(card.includes(`${publicBaseUrl}/card`), true);
    assert.equal(card.includes("8787"), false);

    stdout.reset();
    await runRoomCommand(["invite", "auditor", "--kind", "agent"], context);
    const inviteText = stdout.text();
    assert.equal(inviteText.includes(`${publicBaseUrl}/card`), true);
    assert.equal(inviteText.includes("8787"), false);
  } finally {
    await broker.close();
  }
});

test("failed tunnel registration leaves the current room URL unchanged", async () => {
  const { context, stdout } = await makeContext();
  const broker = await startBroker(new TunnelBroker({ routeTtlMs: 60_000 }));
  try {
    await runRoomCommand(["start", "demo-room", "--alias", "host", "--json"], context);

    // First registration claims the slug.
    await runTunnelCommand(
      ["start", "--broker", broker.baseUrl, "--subdomain", "taken-room", "--json"],
      context
    );

    stdout.reset();
    await runRoomCommand(["current", "--json"], context);
    const afterFirst = stdout.json<{ current: { baseUrl: string } }>().current.baseUrl;
    assert.equal(afterFirst, `${broker.baseUrl}/taken-room`);

    // Second registration for the same active slug must fail and not change state.
    await assert.rejects(
      runTunnelCommand(["start", "--broker", broker.baseUrl, "--subdomain", "taken-room", "--json"], context),
      /route/i
    );

    stdout.reset();
    await runRoomCommand(["current", "--json"], context);
    const afterFailure = stdout.json<{ current: { baseUrl: string } }>().current.baseUrl;
    assert.equal(afterFailure, afterFirst);
  } finally {
    await broker.close();
  }
});

test("broker host endpoints support register, heartbeat, and close over HTTP", async () => {
  const broker = await startBroker(new TunnelBroker({ routeTtlMs: 60_000 }));
  try {
    const client = new TunnelClient(broker.baseUrl);
    const registered = await client.register("session-room");
    assert.equal(registered.publicBaseUrl, `${broker.baseUrl}/session-room`);
    assert.equal(registered.route.status, "active");

    const beat = await client.heartbeat(registered.route.route_id, registered.route.host_connection_id);
    assert.equal(beat.status, "active");

    const closed = await client.close(registered.route.route_id, registered.route.host_connection_id);
    assert.deepEqual(closed, { ok: true, route_slug: "session-room", status: "closed" });

    await assert.rejects(
      client.heartbeat(registered.route.route_id, registered.route.host_connection_id),
      /route/i
    );
  } finally {
    await broker.close();
  }
});

test("tunnel start validates required flags and slug shape", async () => {
  const { context } = await makeContext();
  await runRoomCommand(["start", "demo-room", "--json"], context);

  await assert.rejects(runTunnelCommand(["start", "--subdomain", "ok-room"], context), /--broker is required/);
  await assert.rejects(
    runTunnelCommand(["start", "--broker", "http://127.0.0.1:9", "--subdomain", "Bad_Slug"], context),
    /subdomain/
  );
  await assert.rejects(
    runTunnelCommand(["start", "--room", "other", "--broker", "http://127.0.0.1:9", "--subdomain", "ok-room"], context),
    /--room current/
  );
});
