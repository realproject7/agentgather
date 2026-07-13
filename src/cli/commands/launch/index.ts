// Local Workspace Launcher (#232).
//
// Bare `agentgather` opens the device-local dashboard in the default browser and
// keeps a freshly started server foreground-owned until Ctrl-C, matching
// `platform serve`. It never creates a room, token, tunnel, or remote listener:
// the only side effect is a localhost dashboard on 127.0.0.1 and a single browser
// open.
//
// Before binding it probes `GET http://127.0.0.1:<port>/version`:
//   - a same-version Agent Gather dashboard is reused (open once, exit 0, no
//     second listener);
//   - any other server on the port is left completely untouched — the launcher
//     refuses with a token-free message that names the port and the --port
//     recovery path (never a kill or inspect);
//   - a refused connection means the port is free, so the launcher starts its own
//     dashboard there.

import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { platform as osPlatform } from "node:os";
import { parseArgs, type ParsedArgs } from "../../args.js";
import type { CliContext } from "../../context.js";
import { DEFAULT_PLATFORM_PORT, defaultWaitForShutdown } from "../platform/index.js";
import { buildHelpText, VERSION } from "../../help.js";
import { createPlatformHttpServer } from "../../../platform/index.js";

// What a /version probe found on the requested port.
//   compatible  — a same-version Agent Gather dashboard (reuse it)
//   incompatible — a different server answered / the port is otherwise busy (refuse)
//   absent      — the connection was refused, so the port is free (bind)
type ProbeResult = "compatible" | "incompatible" | "absent";

export interface LaunchCommandHooks {
  // Injectable so tests can drive reuse/refuse/bind decisions without a real
  // server, open a browser without a real one, and stop the keep-alive loop.
  probeVersion?: (port: number) => Promise<ProbeResult>;
  openBrowser?: (url: string) => Promise<boolean>;
  waitForShutdown?: (server: Server) => Promise<void>;
}

export async function runLaunchCommand(
  argv: string[],
  context: CliContext,
  hooks: LaunchCommandHooks = {}
): Promise<number> {
  // Help/version win anywhere on the launcher line (e.g. `agentgather --port 8788
  // --help`) and stay strictly side-effect free — printed before any probe/bind.
  if (argv.includes("--help") || argv.includes("-h")) {
    context.stdout.write(`${buildHelpText()}\n`);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    context.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const args = parseArgs(argv);
  // The root launcher accepts ONLY `--port <value>` and flag-only `--no-open`.
  // Reject unsupported flags/positionals up front, before probing or listening,
  // so a typo never silently starts a server with ignored arguments.
  const argError = rejectUnsupportedArgs(args);
  if (argError !== null) {
    context.stderr.write(`${argError}\n`);
    return 1;
  }
  const noOpen = args.flags.get("no-open") === true;
  const port = resolvePort(args);
  if (port === null) {
    context.stderr.write("agentgather --port takes an integer between 1 and 65535.\n");
    return 1;
  }
  const url = `http://127.0.0.1:${port}`;

  const probeVersion = hooks.probeVersion ?? defaultProbeVersion;
  const probe = await probeVersion(port);

  if (probe === "incompatible") {
    context.stderr.write(
      `Port ${port} is already in use by another server, and Agent Gather won't touch it.\n` +
        `Open the dashboard on a different port: agentgather --port <another-port>\n`
    );
    return 1;
  }

  if (probe === "compatible") {
    // A same-version dashboard is already serving this port: reuse it, open once,
    // and exit without starting a second listener.
    context.stdout.write(`Agent Gather dashboard is already running at ${url}\n`);
    await finishReachable(url, noOpen, context, hooks);
    return 0;
  }

  // The port is free: start our own localhost dashboard against the local home.
  const server = createPlatformHttpServer({ root: context.home });
  const listening = await listen(server, port);
  if (!listening) {
    // A process grabbed the port between the probe and the bind. Never kill it.
    context.stderr.write(
      `Port ${port} is already in use, and Agent Gather won't touch it.\n` +
        `Open the dashboard on a different port: agentgather --port <another-port>\n`
    );
    return 1;
  }

  context.stdout.write(`Agent Gather dashboard is running at ${url}\n`);
  await finishReachable(url, noOpen, context, hooks);
  context.stdout.write("Leave this running; press Ctrl-C to stop the dashboard.\n");

  const waitForShutdown = hooks.waitForShutdown ?? defaultWaitForShutdown;
  await waitForShutdown(server);
  return 0;
}

// Once the dashboard is reachable, either open it in the browser (convenience) or,
// in --no-open mode, just print the stable token-free URL for CI/headless use.
async function finishReachable(
  url: string,
  noOpen: boolean,
  context: CliContext,
  hooks: LaunchCommandHooks
): Promise<void> {
  if (noOpen) {
    context.stdout.write(`${url}\n`);
    return;
  }
  const openBrowser = hooks.openBrowser ?? defaultOpenBrowser;
  const opened = await openBrowser(url);
  if (opened) {
    context.stdout.write("Opened it in your default browser.\n");
  } else {
    // Opening a browser is convenience only: the dashboard is already reachable.
    context.stdout.write(`Couldn't open a browser automatically — visit ${url} to reach the dashboard.\n`);
  }
}

// Enforce the root launcher's exact arg contract: no positionals, no flags other
// than `--port` and `--no-open`, and `--no-open` must be value-less. Returns a
// token-free error string when the invocation is out of contract, else null.
function rejectUnsupportedArgs(args: ParsedArgs): string | null {
  const usage = "agentgather accepts only --port <1..65535> and --no-open (or --help / --version).";
  if (args.positional.length > 0) return usage;
  for (const key of args.flags.keys()) {
    if (key !== "port" && key !== "no-open") return usage;
  }
  if (args.flags.has("no-open") && args.flags.get("no-open") !== true) {
    return "agentgather --no-open takes no value.";
  }
  return null;
}

// `--port` defaults to the dashboard port; when supplied it must be an integer in
// 1..65535 (0/ephemeral is not a meaningful target for an everyday launcher).
function resolvePort(args: ParsedArgs): number | null {
  const raw = args.flags.get("port");
  if (raw === undefined) return DEFAULT_PLATFORM_PORT;
  if (typeof raw !== "string") return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return port;
}

// Token-free identity probe. A 2xx whose body is this exact CLI version is a
// reusable dashboard; a refused connection means the port is free; anything else
// (a foreign server, a different version, a timeout) is treated as busy so the
// launcher refuses instead of fighting for the port.
async function defaultProbeVersion(port: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/version`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) return "incompatible";
    const body = (await response.json()) as { ok?: unknown; name?: unknown; version?: unknown };
    if (body.ok === true && body.name === "agentgather" && body.version === VERSION) return "compatible";
    return "incompatible";
  } catch (error) {
    return isConnectionRefused(error) ? "absent" : "incompatible";
  } finally {
    clearTimeout(timer);
  }
}

// A refused connection (nothing listening) surfaces as ECONNREFUSED on the fetch
// error's cause; everything else means something is there.
function isConnectionRefused(error: unknown): boolean {
  const cause = (error as { cause?: unknown }).cause;
  const code = (cause as { code?: unknown } | undefined)?.code ?? (error as { code?: unknown }).code;
  return code === "ECONNREFUSED";
}

function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = (): void => {
      server.removeListener("error", onError);
      resolve(false);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve(true);
    });
  });
}

// Open a URL in the default browser without a shell: the platform opener is spawned
// directly with the URL as a single argv element, so there is no shell command
// interpolation. A spawn failure resolves false (non-fatal) rather than throwing.
async function defaultOpenBrowser(url: string): Promise<boolean> {
  const opener = openerCommand(url);
  return new Promise((resolve) => {
    try {
      const child = spawn(opener.file, opener.args, { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

function openerCommand(url: string): { file: string; args: string[] } {
  switch (osPlatform()) {
    case "darwin":
      return { file: "open", args: [url] };
    case "win32":
      return { file: "cmd", args: ["/c", "start", "", url] };
    default:
      return { file: "xdg-open", args: [url] };
  }
}
