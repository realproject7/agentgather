#!/usr/bin/env node
// #243: pack/publish guard. Every `bin` target declared in package.json must
// exist as a non-empty built file before the tarball is assembled, so a clean
// checkout cannot ship a package whose CLI entry point is missing or stale.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const declared = typeof manifest.bin === "string" ? { [manifest.name]: manifest.bin } : (manifest.bin ?? {});
const entries = Object.entries(declared);
const errors = [];

if (entries.length === 0) {
  errors.push("package.json declares no bin entry to verify");
}

for (const [command, target] of entries) {
  const full = path.join(root, target);
  let info;
  try {
    info = await stat(full);
  } catch {
    errors.push(`bin "${command}" -> ${target} is missing; run \`pnpm build\` before packing`);
    continue;
  }
  if (!info.isFile()) {
    errors.push(`bin "${command}" -> ${target} is not a file`);
  } else if (info.size === 0) {
    errors.push(`bin "${command}" -> ${target} is empty`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`check-package-bin: ${error}`);
  process.exit(1);
}
