#!/usr/bin/env node
import { buildHelpText, VERSION } from "./help.js";

function main(argv: string[]): number {
  const [command] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(`${buildHelpText()}\n`);
    return 0;
  }

  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${buildHelpText()}\n`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
