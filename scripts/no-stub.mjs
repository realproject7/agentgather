#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const scannedDirs = ["src", "test"];
const blocked = [
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /\bmock\b/i,
  /\bstub\b/i,
  /\bplaceholder\b/i,
  /\btemporary\s+(code|implementation|runtime|fix)\b/i
];
const findings = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath);
      continue;
    }
    if (![".ts", ".js", ".mjs"].includes(path.extname(entry.name))) continue;
    const text = await readFile(fullPath, "utf8");
    const rel = path.relative(root, fullPath);
    text.split("\n").forEach((line, index) => {
      for (const pattern of blocked) {
        if (pattern.test(line)) findings.push(`${rel}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

for (const dir of scannedDirs) {
  await walk(path.join(root, dir));
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  process.exit(1);
}
