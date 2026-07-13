import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { AddressInfo, createServer as createNetServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CliContext } from "../src/cli/context.js";
import { runLaunchCommand } from "../src/cli/commands/launch/index.js";
import { createPlatformHttpServer } from "../src/platform/index.js";
import { VERSION } from "../src/cli/help.js";

const cliPath = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));
const TOKEN_LEAK = /tgl_|Bearer|token=|#token=/i;

function makeCtx(home: string): { ctx: CliContext; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = {
    home,
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) }
  } as unknown as CliContext;
  return { ctx, out: () => out.join(""), err: () => err.join("") };
}

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-cli-launch-"));
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// A freshly started dashboard opens the browser once, prints its localhost URL,
// and stays foreground-owned until the shutdown hook resolves.
test("bare launch starts the local dashboard, opens it once, and keeps it alive (#232)", async () => {
  const { ctx, out, err } = makeCtx(await makeRoot());
  const port = await getFreePort();
  const opened: string[] = [];
  let servedVersion: { ok?: boolean; name?: string; version?: string } | null = null;

  const code = await runLaunchCommand(["--port", String(port)], ctx, {
    probeVersion: async () => "absent",
    openBrowser: async (url) => {
      opened.push(url);
      return true;
    },
    waitForShutdown: async (server) => {
      // Prove the launcher actually bound a reachable dashboard before we stop it.
      servedVersion = (await (await fetch(`http://127.0.0.1:${port}/version`)).json()) as typeof servedVersion;
      await closeServer(server);
    }
  });

  assert.equal(code, 0);
  assert.deepEqual(opened, [`http://127.0.0.1:${port}`]);
  assert.match(out(), new RegExp(`http://127\\.0\\.0\\.1:${port}`));
  assert.match(out(), /Ctrl-C/);
  assert.deepEqual(servedVersion, { ok: true, name: "agentgather", version: VERSION });
  assert.equal(TOKEN_LEAK.test(out() + err()), false);
});

// --no-open is the CI/headless escape hatch: it starts the dashboard and prints a
// stable token-free URL without ever invoking the browser opener.
test("launch --no-open starts the dashboard and prints the URL without opening a browser (#232)", async () => {
  const { ctx, out } = makeCtx(await makeRoot());
  const port = await getFreePort();
  let openerCalls = 0;

  const code = await runLaunchCommand(["--no-open", "--port", String(port)], ctx, {
    probeVersion: async () => "absent",
    openBrowser: async () => {
      openerCalls += 1;
      return true;
    },
    waitForShutdown: async (server) => closeServer(server)
  });

  assert.equal(code, 0);
  assert.equal(openerCalls, 0);
  assert.match(out(), new RegExp(`^http://127\\.0\\.0\\.1:${port}$`, "m"));
  assert.equal(TOKEN_LEAK.test(out()), false);
});

// A same-version dashboard already on the port is reused: open once, exit 0, and
// never start a second listener (the shutdown keep-alive loop is not entered).
test("launch reuses a same-version dashboard already serving the port (#232)", async () => {
  const root = await makeRoot();
  const { ctx, out } = makeCtx(root);
  const port = await getFreePort();
  const existing = createPlatformHttpServer({ root });
  await new Promise<void>((resolve) => existing.listen(port, "127.0.0.1", resolve));

  const opened: string[] = [];
  let keptAlive = false;
  try {
    const code = await runLaunchCommand(["--port", String(port)], ctx, {
      // Default probe (real fetch) identifies the running same-version dashboard.
      openBrowser: async (url) => {
        opened.push(url);
        return true;
      },
      waitForShutdown: async () => {
        keptAlive = true;
      }
    });

    assert.equal(code, 0);
    assert.deepEqual(opened, [`http://127.0.0.1:${port}`]);
    assert.equal(keptAlive, false, "reuse must not start a second listener / keep-alive loop");
    assert.match(out(), /already running/);
    // The original server is untouched and still the sole listener on the port.
    const probe = (await (await fetch(`http://127.0.0.1:${port}/version`)).json()) as { version: string };
    assert.equal(probe.version, VERSION);
    assert.equal(TOKEN_LEAK.test(out()), false);
  } finally {
    await closeServer(existing);
  }
});

// A foreign / version-incompatible server on the port is left completely
// untouched; the launcher exits non-zero and points at the --port recovery path.
test("launch refuses an occupied/incompatible port without touching that process (#232)", async () => {
  const { ctx, out, err } = makeCtx(await makeRoot());
  const port = await getFreePort();
  const foreign = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "agentgather", version: "0.0.0-incompatible" }));
  });
  await new Promise<void>((resolve) => foreign.listen(port, "127.0.0.1", resolve));

  try {
    const code = await runLaunchCommand(["--port", String(port)], ctx, {
      openBrowser: async () => {
        throw new Error("must not open a browser for an occupied port");
      },
      waitForShutdown: async () => {
        throw new Error("must not start a server for an occupied port");
      }
    });

    assert.equal(code, 1);
    assert.match(err(), new RegExp(`Port ${port}`));
    assert.match(err(), /agentgather --port <another-port>/);
    assert.equal(out(), "");
    // The foreign process is never killed or mutated: it still answers.
    const alive = await fetch(`http://127.0.0.1:${port}/version`);
    assert.equal(alive.status, 200);
    assert.equal(TOKEN_LEAK.test(err()), false);
  } finally {
    await closeServer(foreign);
  }
});

// Opening a browser is convenience only: a failing opener leaves the dashboard
// running and prints the URL rather than failing the launch.
test("launch treats a browser-opener failure as non-fatal once the dashboard is listening (#232)", async () => {
  const { ctx, out } = makeCtx(await makeRoot());
  const port = await getFreePort();

  const code = await runLaunchCommand(["--port", String(port)], ctx, {
    probeVersion: async () => "absent",
    openBrowser: async () => false,
    waitForShutdown: async (server) => closeServer(server)
  });

  assert.equal(code, 0);
  assert.match(out(), /Couldn't open a browser/);
  assert.match(out(), new RegExp(`http://127\\.0\\.0\\.1:${port}`));
});

// Invalid --port values are rejected before any probe/bind, with a token-free error.
test("launch rejects an out-of-range or non-numeric --port (#232)", async () => {
  for (const bad of [["--port", "0"], ["--port", "70000"], ["--port", "abc"], ["--port"]]) {
    const { ctx, err } = makeCtx(await makeRoot());
    const code = await runLaunchCommand(bad, ctx, {
      probeVersion: async () => {
        throw new Error("must not probe for an invalid port");
      }
    });
    assert.equal(code, 1, `expected non-zero for ${JSON.stringify(bad)}`);
    assert.match(err(), /between 1 and 65535/);
  }
});

// `--help` and `--version` short-circuit before the launcher: they exit 0, print
// the reworked help (which surfaces the bare launcher and `room launch`), and do
// NOT hang on a listener or open a browser.
test("help/version stay side-effect free and surface the launcher (#232)", async () => {
  const env = { ...process.env, AGENTGATHER_HOME: await makeRoot() };
  const help = await runCli(["--help"], env);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /agentgather\s+Open the local dashboard/);
  assert.match(help.stdout, /--no-open/);
  assert.match(help.stdout, /--port <1\.\.65535>/);
  assert.match(help.stdout, /room launch \[--detach\]/);
  assert.doesNotMatch(help.stdout, /tgl_/);

  const version = await runCli(["--version"], env);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), VERSION);
});

// End-to-end: bare-flag routing actually launches a reachable dashboard and stays
// alive until an interrupt (Ctrl-C), printing only a token-free localhost URL.
test("the CLI routes --no-open to a real, reachable dashboard that stops on SIGINT (#232)", async () => {
  const env = { ...process.env, AGENTGATHER_HOME: await makeRoot() };
  const port = await getFreePort();
  const child = spawn(process.execPath, [cliPath, "--no-open", "--port", String(port)], { env });

  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });

  try {
    await waitFor(() => stdout.includes("dashboard is running"), 15_000);
    const probe = (await (await fetch(`http://127.0.0.1:${port}/version`)).json()) as { name: string; version: string };
    assert.equal(probe.name, "agentgather");
    assert.equal(probe.version, VERSION);
    assert.match(stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}`));
    assert.equal(TOKEN_LEAK.test(stdout), false);
  } finally {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGINT");
    await exited;
  }
  // After the interrupt the listener is gone (the dashboard stopped).
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/version`));
});

interface CliResult {
  code: number;
  stdout: string;
}

function runCli(argv: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...argv], { env });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 0, stdout }));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
