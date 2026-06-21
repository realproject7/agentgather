import { readFile } from "node:fs/promises";
import type { ClientMessageInput } from "../../../protocol/index.js";
import { flagBoolean, flagString, parseArgs } from "../../args.js";
import type { CliContext } from "../../context.js";
import { sendMessage } from "../message/transport.js";

export const MAX_HANDOFF_SUMMARY_LENGTH = 12_000;

export async function runHandoffCommand(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const target = args.positional[0];
  const summarySource = flagString(args, "summary");
  if (target === undefined || summarySource === undefined) {
    throw new Error("handoff requires <alias> and --summary");
  }
  const summary = await readSummary(summarySource);
  if (summary.length > MAX_HANDOFF_SUMMARY_LENGTH) {
    throw new Error(`handoff summary must be <= ${MAX_HANDOFF_SUMMARY_LENGTH} characters`);
  }
  const input: ClientMessageInput = {
    type: "handoff",
    text: `@${target} HANDOFF\n\n${summary}`
  };
  const result = await sendMessage(context, input);
  if (flagBoolean(args, "json")) {
    context.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    context.stdout.write(`handoff #${result.message.id} sent to @${target}\n`);
  }
  return 0;
}

async function readSummary(source: string): Promise<string> {
  if (source.length > MAX_HANDOFF_SUMMARY_LENGTH) return source;
  try {
    return await readFile(source, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return source;
    }
    throw error;
  }
}
