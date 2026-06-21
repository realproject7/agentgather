import { parseAgentKind, renderAgentInstructions } from "../../../protocol/index.js";
import { flagString, parseArgs } from "../../args.js";
import type { CliContext } from "../../context.js";

export async function runInstructionsCommand(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  context.stdout.write(`${renderAgentInstructions(parseAgentKind(flagString(args, "agent")))}\n`);
  return 0;
}

