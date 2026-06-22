#!/usr/bin/env node
import { buildHelpText, VERSION } from "./help.js";
import { createCliContext } from "./context.js";
import { runAttendCommand } from "./commands/attend/index.js";
import { runBrokerCommand } from "./commands/broker/index.js";
import { runDoctorCommand } from "./commands/doctor/index.js";
import { runExportCommand } from "./commands/export/index.js";
import { runHandoffCommand } from "./commands/handoff/index.js";
import { runInstructionsCommand } from "./commands/instructions/index.js";
import { runMessagesCommand, runReadCommand, runReplyCommand, runSendCommand } from "./commands/message/index.js";
import { runRoomCommand } from "./commands/room/index.js";
import { runTunnelCommand } from "./commands/tunnel/index.js";
import { runWatchCommand } from "./commands/watch/index.js";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(`${buildHelpText()}\n`);
    return 0;
  }

  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (command === "room") {
    return runRoomCommand(rest, createCliContext());
  }
  if (command === "tunnel") {
    return runTunnelCommand(rest, createCliContext());
  }
  if (command === "broker") {
    return runBrokerCommand(rest, createCliContext());
  }
  if (command === "send") return runSendCommand(rest, createCliContext());
  if (command === "messages") return runMessagesCommand(rest, createCliContext());
  if (command === "read") return runReadCommand(rest, createCliContext());
  if (command === "reply") return runReplyCommand(rest, createCliContext());
  if (command === "watch") return runWatchCommand(rest, createCliContext());
  if (command === "attend") return runAttendCommand(rest, createCliContext());
  if (command === "handoff") return runHandoffCommand(rest, createCliContext());
  if (command === "export") return runExportCommand(rest, createCliContext());
  if (command === "doctor") return runDoctorCommand(rest, createCliContext());
  if (command === "instructions") return runInstructionsCommand(rest, createCliContext());

  process.stderr.write(`Unknown command: ${command}\n\n${buildHelpText()}\n`);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
