// #303 — make a failed run's SILENCE readable.
//
// Run 31026009385 failed on a real 30-second browser timeout and published no
// artifact. `if-no-files-found: ignore` meant "the recorder was quiet" and "the
// recorder was never attached" looked identical from the outside, and the only
// way to tell them apart was to read the test sources at that commit.
//
// This writes one status file into the artifact directory on a failed run, so
// the upload always carries something, and that something says which of the two
// happened. It records file NAMES and COUNTS only — never artifact contents — so
// it cannot leak what the recorder itself is built never to collect.
import { mkdir, readdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { surveyBrowserWaitSurface, formatInventory } from "./browser-wait-surface.mjs";

const STATUS_FILE = "attachment-status.md";
const DIAGNOSTICS_DIR = process.env.DIAGNOSTICS_DIR ?? "test-artifacts";

// The survey reads the checked-out sources, not the working directory, so the
// status is about this commit even when the script is run from elsewhere. An
// explicit root is how the coverage test drives the not-attached branch: proving
// that branch is reachable needs a tree where a block really is uncovered.
const repoRoot = path.resolve(process.env.BROWSER_SURFACE_ROOT ?? path.join(import.meta.dirname, ".."));

async function listArtifacts(dir) {
  try {
    const names = await readdir(dir);
    return names.filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function buildStatus(dir) {
  const artifacts = await listArtifacts(dir);
  const inventory = surveyBrowserWaitSurface(repoRoot);
  const blocks = inventory.reduce((sum, entry) => sum + entry.blocks.length, 0);
  const covered = inventory.reduce((sum, entry) => sum + entry.covered, 0);
  const uncovered = inventory.flatMap((entry) =>
    entry.uncovered.map((block) => `${entry.file}:${block.line} — ${block.title}`)
  );
  const excepted = inventory.flatMap((entry) =>
    entry.excepted.map((block) => `${entry.file}:${block.line} — ${block.title} (exception: ${block.exception})`)
  );
  const written = artifacts ?? [];

  const lines = [
    "# Browser failure diagnostics — attachment status (#303)",
    "",
    `- diagnostic artifacts written this run: **${written.length}**`,
    `- browser test blocks in the 30s wait surface: **${blocks}**`,
    `- blocks with the recorder attached and written on failure: **${covered}**`,
    `- blocks with a documented exception: **${excepted.length}**`,
    `- blocks with neither: **${uncovered.length}**`,
    ""
  ];

  if (written.length > 0) {
    lines.push("**The recorder attached and wrote.** Files in this artifact:", "");
    for (const name of written) lines.push(`- \`${name}\``);
    lines.push("");
  } else if (uncovered.length === 0) {
    lines.push(
      "**The recorder was attached and quiet.** Every block in the wait surface writes",
      "an artifact when it throws, so a browser wait that consumed its ceiling would",
      "have produced one. No artifact means this run failed somewhere else — lint,",
      "typecheck, a non-browser test — or before the awaited catch was reached.",
      ""
    );
  } else {
    lines.push(
      "**The recorder was NOT attached everywhere.** No artifact was written, and the",
      "blocks below are not covered. If the failing test is one of them, the silence",
      "is the missing recorder rather than a quiet one:",
      ""
    );
    for (const gap of uncovered) lines.push(`- ${gap}`);
    lines.push("");
  }

  if (excepted.length > 0) {
    lines.push("Documented exceptions:", "");
    for (const entry of excepted) lines.push(`- ${entry}`);
    lines.push("");
  }

  lines.push("## Coverage at this commit", "", formatInventory(inventory), "");
  return lines.join("\n");
}

export async function writeStatus(dir = DIAGNOSTICS_DIR) {
  const body = await buildStatus(dir);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, STATUS_FILE);
  await writeFile(file, body, "utf8");
  return { file, body };
}

if (import.meta.filename === process.argv[1]) {
  const { body } = await writeStatus();
  console.log(body);
  // The same text on the run's summary page, so the answer is visible without
  // downloading anything.
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${body}\n`, "utf8");
}
