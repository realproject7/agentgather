import { assertSafeSlug } from "../../../protocol/index.js";
import { HostTunnelSession, TunnelClient, TunnelError, writeHostTunnelState } from "../../../tunnel/index.js";
import { parseArgs, flagBoolean, flagString } from "../../args.js";
import type { CliContext } from "../../context.js";
import { readCurrent, writeCurrent } from "../../state.js";

const DEFAULT_TARGET = "http://127.0.0.1:8787";
const PRE_REGISTRATION_WARNING =
  "Warning: invite cards generated before tunnel registration may still contain localhost URLs.";

export async function runTunnelCommand(argv: string[], context: CliContext): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "start") return tunnelStart(rest, context);
  if (subcommand === "run") return tunnelRun(rest, context);
  context.stderr.write(`Unknown tunnel command: ${subcommand ?? ""}\n`);
  return 1;
}

interface RelayRegistration {
  brokerUrl: string;
  subdomain: string;
  targetUrl: string;
  client: TunnelClient;
  route: { route_slug: string; route_id: string; host_connection_id: string; created_at: string };
  publicBaseUrl: string;
}

// Register for managed relay mode (no broker target) and persist host state.
// State is written only after the broker confirms, so a failed registration
// leaves current.json and tunnel.json untouched.
async function registerRelay(args: ReturnType<typeof parseArgs>, context: CliContext): Promise<RelayRegistration> {
  const room = flagString(args, "room") ?? "current";
  if (room !== "current") throw new Error("tunnel run only supports --room current");
  const brokerUrl = parseHttpUrl(requireFlag(args, "broker"), "--broker");
  const subdomain = requireFlag(args, "subdomain");
  assertSafeSlug(subdomain, "subdomain");
  const targetUrl = parseHttpUrl(flagString(args, "target") ?? DEFAULT_TARGET, "--target");

  const current = await readCurrent(context.home);
  const client = new TunnelClient(brokerUrl);
  const { route, publicBaseUrl } = await client.register(subdomain);

  await writeHostTunnelState(context.home, current.roomId, {
    public_base_url: publicBaseUrl,
    route_slug: route.route_slug,
    route_id: route.route_id,
    host_connection_id: route.host_connection_id,
    broker_url: brokerUrl,
    target_url: targetUrl,
    registered_at: route.created_at
  });
  await writeCurrent(context.home, { ...current, baseUrl: publicBaseUrl });

  return { brokerUrl, subdomain, targetUrl, client, route, publicBaseUrl };
}

async function tunnelRun(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const { client, route, targetUrl, publicBaseUrl } = await registerRelay(args, context);

  context.stdout.write(
    `Tunnel running at ${publicBaseUrl}\n` +
      `Keep this command running while the public tunnel is active.\n${PRE_REGISTRATION_WARNING}\n`
  );

  let resolveShutdown: () => void = () => {};
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const session = new HostTunnelSession(client, {
    routeId: route.route_id,
    hostConnectionId: route.host_connection_id,
    target: targetUrl,
    onError: () => resolveShutdown()
  });
  const onSignal = (): void => resolveShutdown();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  session.start();

  await shutdown;
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  await session.stop({ closeRoute: true });

  const failure = session.failure;
  const reason = failure instanceof TunnelError ? failure.code : "signal";
  context.stdout.write(`Tunnel closed (${reason}).\n`);
  return 0;
}

async function tunnelStart(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);

  const room = flagString(args, "room") ?? "current";
  if (room !== "current") throw new Error("tunnel start only supports --room current");

  const brokerUrl = parseHttpUrl(requireFlag(args, "broker"), "--broker");
  const subdomain = requireFlag(args, "subdomain");
  assertSafeSlug(subdomain, "subdomain");
  // The target local room URL is recorded host-side for the forwarding core
  // (#36). The broker stores only ephemeral route metadata, so it is not sent
  // to the broker in this ticket.
  const targetUrl = parseHttpUrl(flagString(args, "target") ?? DEFAULT_TARGET, "--target");

  const current = await readCurrent(context.home);

  // Register first. The current room URL is only updated after the broker
  // confirms the route, so a failed registration leaves local state unchanged.
  const client = new TunnelClient(brokerUrl);
  const { route, publicBaseUrl } = await client.register(subdomain, targetUrl);

  await writeHostTunnelState(context.home, current.roomId, {
    public_base_url: publicBaseUrl,
    route_slug: route.route_slug,
    route_id: route.route_id,
    host_connection_id: route.host_connection_id,
    broker_url: brokerUrl,
    target_url: targetUrl,
    registered_at: route.created_at
  });
  await writeCurrent(context.home, { ...current, baseUrl: publicBaseUrl });

  if (flagBoolean(args, "json")) {
    context.stdout.write(
      `${JSON.stringify({
        ok: true,
        route_slug: route.route_slug,
        public_base_url: publicBaseUrl,
        broker_url: brokerUrl,
        target_url: targetUrl,
        route_id: route.route_id,
        warning: PRE_REGISTRATION_WARNING
      })}\n`
    );
  } else {
    context.stdout.write(`Tunnel route published at ${publicBaseUrl}\n${PRE_REGISTRATION_WARNING}\n`);
  }
  return 0;
}

function requireFlag(args: ReturnType<typeof parseArgs>, key: string): string {
  const value = flagString(args, key);
  if (value === undefined) throw new Error(`--${key} is required`);
  return value;
}

function parseHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  return url.toString();
}
