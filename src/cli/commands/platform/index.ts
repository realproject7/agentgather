import type { Server } from "node:http";
import { flagBoolean, flagString, parseArgs } from "../../args.js";
import type { CliContext } from "../../context.js";
import { createPlatformHttpServer } from "../../../platform/index.js";

// Default control-plane port: room serve uses 8787, the broker 8799; the owner
// shell sits alongside them without colliding.
const DEFAULT_PLATFORM_PORT = 8788;

export interface PlatformCommandHooks {
  // Injectable so tests can drive the running server and shut it down instead of
  // blocking on process signals forever.
  waitForShutdown?: (server: Server) => Promise<void>;
}

export async function runPlatformCommand(
  argv: string[],
  context: CliContext,
  hooks: PlatformCommandHooks = {}
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "serve") return platformServe(rest, context, hooks);
  context.stderr.write(
    `Unknown platform subcommand: ${subcommand ?? "(none)"}\n` +
      `Usage: agentgather platform serve [--port ${DEFAULT_PLATFORM_PORT}] [--host 127.0.0.1] [--allow-remote] [--json]\n`
  );
  return 1;
}

async function platformServe(argv: string[], context: CliContext, hooks: PlatformCommandHooks): Promise<number> {
  const args = parseArgs(argv);
  // 0 is allowed: it asks the OS for an ephemeral port (used by tests and ad-hoc runs).
  const port = Number(flagString(args, "port") ?? String(DEFAULT_PLATFORM_PORT));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("port must be an integer between 0 and 65535");
  }
  const host = flagString(args, "host") ?? "127.0.0.1";
  const allowRemote = flagBoolean(args, "allow-remote");
  // Mirror `room serve`: localhost-only unless the operator explicitly opts in.
  if (!allowRemote && !isLocalBindHost(host)) {
    throw new Error("remote platform serving requires --allow-remote");
  }

  const server = createPlatformHttpServer({ root: context.home, allowInsecureRemote: allowRemote });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  const url = `http://${host}:${boundPort}`;

  if (flagBoolean(args, "json")) {
    // No secrets: only the bind coordinates and the boundary note. Tokens, invite
    // URLs, and message bodies never appear here.
    context.stdout.write(`${JSON.stringify({ ok: true, url, host, port: boundPort, control_plane: "metadata-only" })}\n`);
  } else {
    context.stdout.write(`Serving the control-plane owner shell at ${url}\n`);
    context.stdout.write(
      "Control plane serves room metadata only; the chat pane reads host-owned logs live (never stored centrally).\n"
    );
  }

  const waitForShutdown = hooks.waitForShutdown ?? defaultWaitForShutdown;
  await waitForShutdown(server);
  return 0;
}

function defaultWaitForShutdown(server: Server): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function isLocalBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
