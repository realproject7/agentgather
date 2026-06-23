import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runDoctorCommand } from "../src/cli/commands/doctor/index.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { runWatchCommand } from "../src/cli/commands/watch/index.js";
import type { WaitResponse } from "../src/protocol/index.js";

const PUBLIC_BASE = "https://rooms.agentgather.dev/ag-smoke-1782196769";

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
}

async function makeContext(): Promise<{ context: CliContext; stdout: Capture }> {
  const stdout = new Capture();
  return {
    context: {
      home: await mkdtemp(path.join(os.tmpdir(), "agentgather-path-url-test-")),
      stdout,
      stderr: new Capture()
    },
    stdout
  };
}

// Record every URL the CLI requests so we can assert the path-based room slug
// survives URL construction (no leading-slash drop to the bare host).
function interceptFetch(handler: (url: string) => Response): { urls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    urls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

function waitPayload(): WaitResponse {
  return {
    ok: true,
    room: "ag-smoke",
    room_status: "open",
    participant: "agent",
    heartbeat: false,
    messages: [],
    mentioned: false,
    next_since_id: 0,
    keep_waiting: true,
    next_cmd: null
  };
}

test("watch targets /<slug>/wait for a path-based public base URL", async () => {
  const { context } = await makeContext();
  await runRoomCommand(["start", "path-room", "--alias", "agent", "--url", PUBLIC_BASE, "--json"], context);

  const recorder = interceptFetch(() => new Response(JSON.stringify(waitPayload()), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
  try {
    await runWatchCommand(["--since", "0", "--json"], context);
  } finally {
    recorder.restore();
  }

  assert.equal(recorder.urls.length, 1);
  const waitUrl = recorder.urls[0] ?? "";
  assert.match(waitUrl, /^https:\/\/rooms\.agentgather\.dev\/ag-smoke-1782196769\/wait\?/);
  assert.doesNotMatch(waitUrl, /agentgather\.dev\/wait/);
});

test("doctor targets /<slug>/status and /<slug>/wait for a path-based public base URL", async () => {
  const { context, stdout } = await makeContext();
  await runRoomCommand(["start", "path-doctor-room", "--alias", "agent", "--url", PUBLIC_BASE, "--json"], context);
  stdout.chunks = [];

  const recorder = interceptFetch((url) =>
    url.includes("/wait")
      ? new Response(JSON.stringify(waitPayload()), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  );
  try {
    await runDoctorCommand(["--json"], context);
  } finally {
    recorder.restore();
  }

  const statusUrl = recorder.urls.find((url) => url.includes("/status"));
  const waitUrl = recorder.urls.find((url) => url.includes("/wait"));
  assert.equal(statusUrl, "https://rooms.agentgather.dev/ag-smoke-1782196769/status");
  assert.match(waitUrl ?? "", /^https:\/\/rooms\.agentgather\.dev\/ag-smoke-1782196769\/wait\?/);
  assert.doesNotMatch(statusUrl ?? "", /agentgather\.dev\/status/);
});

test("roomUrl keeps localhost endpoints unchanged", async () => {
  const { context } = await makeContext();
  await runRoomCommand(["start", "local-room", "--alias", "agent", "--url", "http://127.0.0.1:8787", "--json"], context);

  const recorder = interceptFetch(() => new Response(JSON.stringify(waitPayload()), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
  try {
    await runWatchCommand(["--since", "0", "--json"], context);
  } finally {
    recorder.restore();
  }

  assert.match(recorder.urls[0] ?? "", /^http:\/\/127\.0\.0\.1:8787\/wait\?/);
});
