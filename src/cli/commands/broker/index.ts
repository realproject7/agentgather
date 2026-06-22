import { createBrokerHttpServer, TunnelBroker } from "../../../tunnel/index.js";
import { parseArgs, flagString } from "../../args.js";
import type { CliContext } from "../../context.js";

export async function runBrokerCommand(argv: string[], context: CliContext): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "serve") return brokerServe(rest, context);
  context.stderr.write(`Unknown broker command: ${subcommand ?? ""}\n`);
  return 1;
}

async function brokerServe(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);

  const host = flagString(args, "host") ?? "127.0.0.1";
  const port = parsePort(flagString(args, "port") ?? "8799");
  const publicUrl = parseOptionalHttpUrl(flagString(args, "public-url"));

  // The broker only logs the redaction-safe coarse fields its BrokerLogger
  // allows, so routing them to stdout is safe for systemd/Caddy journals.
  const broker = new TunnelBroker({
    logSink: (record) => context.stdout.write(`${JSON.stringify(record)}\n`)
  });
  const server = createBrokerHttpServer(broker);
  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });

  context.stdout.write(`Telegent broker serving on ${host}:${port}\n`);
  if (publicUrl !== undefined) context.stdout.write(`Public URL: ${publicUrl}\n`);
  context.stdout.write("Stores only ephemeral route metadata; no room history, message bodies, or participant tokens.\n");

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  context.stdout.write("Telegent broker stopped.\n");
  return 0;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return port;
}

function parseOptionalHttpUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--public-url must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--public-url must use http or https");
  }
  return value;
}
