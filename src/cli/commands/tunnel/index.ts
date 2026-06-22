import { assertSafeSlug } from "../../../protocol/index.js";
import { TunnelClient, writeHostTunnelState } from "../../../tunnel/index.js";
import { parseArgs, flagBoolean, flagString } from "../../args.js";
import type { CliContext } from "../../context.js";
import { readCurrent, writeCurrent } from "../../state.js";

const DEFAULT_TARGET = "http://127.0.0.1:8787";
const PRE_REGISTRATION_WARNING =
  "Warning: invite cards generated before tunnel registration may still contain localhost URLs.";

export async function runTunnelCommand(argv: string[], context: CliContext): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "start") return tunnelStart(rest, context);
  context.stderr.write(`Unknown tunnel command: ${subcommand ?? ""}\n`);
  return 1;
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
