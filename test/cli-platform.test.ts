import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runPlatformCommand } from "../src/cli/commands/platform/index.js";
import { appendServerMessage, createRoom } from "../src/storage/index.js";
import { createControlPlaneRoom } from "../src/platform/index.js";

function makeCtx(home: string): { ctx: CliContext; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = { home, stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } } as unknown as CliContext;
  return { ctx, out: () => out.join(""), err: () => err.join("") };
}

// A control-plane room owned by the default dev owner ("local-owner"), with a real
// host log so the live chat read has something to surface.
async function seedOwnerRoom(root: string): Promise<void> {
  await createControlPlaneRoom(root, {
    room_id: "alpha",
    title: "Alpha Room",
    owner_user_id: "local-owner",
    route_url: "https://rooms.agentgather.dev/alpha",
    status: "active",
    roster: [{ alias: "host", kind: "human", role: "host", status: "attending" }],
    route_health: { reachable: true, host_connected: true },
    last_synced_message_id: 0
  });
  await createRoom({ root, roomId: "alpha", hostAlias: "host", briefBody: "go" });
  await appendServerMessage({ root, roomId: "alpha", from: "system", text: "alpha opened for review" });
}

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-cli-platform-"));
}

test("platform serve starts the owner shell on localhost by default with a no-secrets json line (#176)", async () => {
  const root = await makeRoot();
  await seedOwnerRoom(root);
  const { ctx, out } = makeCtx(root);
  await runPlatformCommand(["serve", "--port", "0", "--json"], ctx, {
    waitForShutdown: async (server) => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  const line = JSON.parse(out().trim()) as { ok: boolean; url: string; host: string; port: number; control_plane: string };
  assert.equal(line.ok, true);
  // Localhost binding is the default.
  assert.equal(line.host, "127.0.0.1");
  assert.equal(typeof line.port, "number");
  assert.ok(line.port > 0);
  assert.equal(line.control_plane, "metadata-only");
  // No tokens / invite URLs / bearer secrets in the command output.
  assert.equal(/token|tgl_|Bearer|#token=/i.test(out()), false);
});

test("platform serve exposes the read-only rooms API and the live host chat with no secrets (#176)", async () => {
  const root = await makeRoot();
  await seedOwnerRoom(root);
  const { ctx } = makeCtx(root);
  await runPlatformCommand(["serve", "--port", "0", "--json"], ctx, {
    waitForShutdown: async (server) => {
      try {
        const port = (server.address() as AddressInfo).port;
        // Rooms API: metadata only.
        const rooms = await fetch(`http://127.0.0.1:${port}/rooms`);
        assert.equal(rooms.status, 200);
        const roomsBody = JSON.stringify(await rooms.json());
        assert.equal(roomsBody.includes("alpha"), true);
        assert.equal(/tgl_|Bearer|"token"/i.test(roomsBody), false);

        // Live host chat read: the host-owned log, flagged available.
        const chat = await fetch(`http://127.0.0.1:${port}/rooms/alpha/messages?since_id=0`);
        assert.equal(chat.status, 200);
        const chatBody = (await chat.json()) as { host_log_available: boolean; messages: Array<{ text: string }> };
        assert.equal(chatBody.host_log_available, true);
        assert.equal(chatBody.messages.some((m) => m.text === "alpha opened for review"), true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
});

test("platform serve refuses a non-local bind without --allow-remote (#176)", async () => {
  const root = await makeRoot();
  const { ctx } = makeCtx(root);
  await assert.rejects(
    () => runPlatformCommand(["serve", "--host", "0.0.0.0", "--port", "0"], ctx, { waitForShutdown: async () => {} }),
    /--allow-remote/
  );
});

test("platform with an unknown subcommand exits non-zero with usage (#176)", async () => {
  const root = await makeRoot();
  const { ctx, err } = makeCtx(root);
  const code = await runPlatformCommand(["frobnicate"], ctx);
  assert.equal(code, 1);
  assert.match(err(), /platform serve/);
});
