#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { checkPanes } from "./check-kit-drift.mjs";

const root = process.cwd();
const textExtensions = new Set([".ts", ".js", ".mjs", ".json", ".md"]);
const ignoredDirs = new Set([".git", ".agentgather", ".ag-rooms", "node_modules", "dist", "coverage"]);
const errors = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath);
      continue;
    }
    if (!textExtensions.has(path.extname(entry.name))) continue;
    const text = await readFile(fullPath, "utf8");
    const rel = path.relative(root, fullPath);
    if (rel === "docs/PROPOSAL.md") continue;
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (/[ \t]+$/.test(line)) {
        errors.push(`${rel}:${index + 1}: trailing whitespace`);
      }
    });
    if (!text.endsWith("\n")) {
      errors.push(`${rel}: missing final newline`);
    }
  }
}

await walk(root);

// Anti-drift guard (#133): panes must not reintroduce raw hex/font outside the kit.
for (const v of await checkPanes(root)) {
  errors.push(`${v.file}:${v.line}: kit-drift (${v.kind}) — ${v.text}; use a kit primitive or a theme token`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
