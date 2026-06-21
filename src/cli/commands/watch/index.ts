import { flagBoolean, flagString, parseArgs } from "../../args.js";
import type { CliContext } from "../../context.js";
import { currentSinceId, formatMessages, waitOnce } from "../message/transport.js";

export async function runWatchCommand(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const sinceId = await currentSinceId(context, flagString(args, "since"));
  const response = await waitOnce(context, sinceId);
  if (flagBoolean(args, "json")) {
    context.stdout.write(`${JSON.stringify(response)}\n`);
    return 0;
  }
  context.stdout.write(formatMessages(response.messages));
  if (response.keep_waiting && response.cli_next_cmd !== null) {
    context.stdout.write(`next: ${response.cli_next_cmd}\n`);
  }
  return 0;
}

