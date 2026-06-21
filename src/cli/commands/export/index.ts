import { writeFile } from "node:fs/promises";
import path from "node:path";
import { flagBoolean, flagString, parseArgs } from "../../args.js";
import type { CliContext } from "../../context.js";
import { readCurrent } from "../../state.js";
import { readBrief, readMessages, readParticipants, readRoomState, roomPaths } from "../../../storage/index.js";

export async function runExportCommand(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const current = await readCurrent(context.home);
  const output = flagString(args, "output") ?? path.join(process.cwd(), `${current.roomId}-export.md`);
  const paths = roomPaths(context.home, current.roomId);
  const [state, brief, participants, messages] = await Promise.all([
    readRoomState(paths),
    readBrief(context.home, current.roomId),
    readParticipants(paths),
    readMessages(context.home, current.roomId)
  ]);
  const body = [
    `# Telegent Room Export: ${state.id}`,
    "",
    `Status: ${state.status}`,
    `Exported at: ${new Date().toISOString()}`,
    `Brief version: ${brief.brief_version}`,
    "",
    "## Room Brief",
    "",
    brief.body || "(empty)",
    "",
    "## Participants",
    "",
    ...participants.map((participant) =>
      `- ${participant.alias}: ${participant.kind}, ${participant.location}, ${participant.install}, ${participant.attention}, last_seen=${participant.lastSeenAt}`
    ),
    "",
    "## Messages",
    "",
    ...messages.map((message) => `- [#${message.id}] ${message.ts} ${message.from} (${message.type}): ${message.text}`)
  ].join("\n");
  await writeFile(output, `${body}\n`);
  return emit(context, flagBoolean(args, "json"), { ok: true, room: current.roomId, output, messages: messages.length }, `Exported ${messages.length} messages to ${output}\n`);
}

function emit(context: CliContext, json: boolean, value: unknown, text: string): number {
  context.stdout.write(json ? `${JSON.stringify(value)}\n` : text);
  return 0;
}

