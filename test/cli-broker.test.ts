import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runBrokerCommand } from "../src/cli/commands/broker/index.js";

class Capture extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _e: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    cb();
  }
  text(): string {
    return this.chunks.join("");
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

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await delay(10);
  }
}

test("broker serve binds, forwards with redaction-safe logs, and shuts down on signal", async () => {
  const stdout = new Capture();
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "telegent-broker-test-")),
    stdout,
    stderr: new Capture()
  };

  const echoPort = await getFreePort();
  const echo = createServer((_req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end("ok");
  });
  await new Promise<void>((resolve) => echo.listen(echoPort, "127.0.0.1", resolve));
  const echoUrl = `http://127.0.0.1:${echoPort}`;

  const port = await getFreePort();
  const runPromise = runBrokerCommand(
    ["serve", "--host", "127.0.0.1", "--port", String(port), "--public-url", "https://rooms.telegent.dev"],
    context
  );
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(() => stdout.text().includes("Telegent broker serving"));

    // Register a direct-target route so a forwarded request produces an access log.
    const registered = await fetch(`${base}/_host/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route_slug: "demo-room", target: echoUrl })
    });
    assert.equal(registered.status, 200);

    const forwarded = await fetch(`${base}/demo-room/card?participant=alice&token=SECRET-TOKEN`, {
      headers: { Authorization: "Bearer SECRET-TOKEN" }
    });
    assert.equal(forwarded.status, 200);

    process.emit("SIGINT");
    const code = await runPromise;
    assert.equal(code, 0);

    const output = stdout.text();
    assert.match(output, new RegExp(`Telegent broker serving on 127\\.0\\.0\\.1:${port}`));
    assert.match(output, /Public URL: https:\/\/rooms\.telegent\.dev/);
    assert.match(output, /ephemeral route metadata/);
    assert.match(output, /Telegent broker stopped\./);

    // An access log line was emitted with coarse, redaction-safe fields only.
    assert.match(output, /"route_hash"/);
    assert.match(output, /"path_class":"card"/);
    for (const secret of ["SECRET-TOKEN", "token=", "Bearer", "Authorization", "demo-room"]) {
      assert.equal(output.includes(secret), false, `broker log leaked: ${secret}`);
    }
  } finally {
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  }
});

test("broker serve rejects an invalid port", async () => {
  const context: CliContext = {
    home: await mkdtemp(path.join(os.tmpdir(), "telegent-broker-bad-")),
    stdout: new Capture(),
    stderr: new Capture()
  };
  await assert.rejects(runBrokerCommand(["serve", "--port", "0"], context), /port/);
});
