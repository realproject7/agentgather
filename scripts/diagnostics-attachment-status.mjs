// #303 — make a failed run's SILENCE readable.
//
// Run 31026009385 failed on a real 30-second browser timeout and published no
// artifact. `if-no-files-found: ignore` meant "the recorder was quiet" and "the
// recorder was never attached" looked identical from the outside, and the only
// way to tell them apart was to read the test sources at that commit.
//
// @re1 on PR #304: a source survey proves a block CONTAINS attachment code, not
// that this execution reached it. A test that throws before `newPage()` — or
// before its `try`, in fixture setup or `chromium.launch()` — attaches nothing
// and writes nothing, and calling that "attached and quiet" is the exact
// collapse this ticket exists to remove. So the verdict below is built from
// RUNTIME evidence:
//
//   1. the run record (`test-run.tap`) says which tests actually failed;
//   2. an artifact under a test's label says a recorder was attached and wrote;
//   3. an `unattached--` artifact says the test failed with no recorder attached;
//   4. neither, for a test in the surface, means it failed before its catch —
//      reported as NOT attached, never as quiet.
//
// The source inventory stays in the report as context, but no longer decides
// what happened. File NAMES and COUNTS only — never artifact contents — so this
// cannot leak what the recorder is built never to collect.
import { mkdir, readdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { surveyBrowserWaitSurface, formatInventory } from "./browser-wait-surface.mjs";

const STATUS_FILE = "attachment-status.md";
const UNATTACHED_PREFIX = "unattached--";
const DIAGNOSTICS_DIR = process.env.DIAGNOSTICS_DIR ?? "test-artifacts";
const RUN_RECORD = process.env.TEST_RUN_RECORD ?? "test-run.tap";

// The survey reads the checked-out sources, not the working directory, so the
// inventory is about this commit even when the script is run from elsewhere. An
// explicit root is how the coverage test drives a tree with a real gap.
const repoRoot = path.resolve(process.env.BROWSER_SURFACE_ROOT ?? path.join(import.meta.dirname, ".."));

async function listArtifacts(dir) {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// `not ok N - <name>` is the TAP form node:test emits for a failed test and for
// a failed file. Both are useful: the file names where, the test names what.
async function readFailedTests(file) {
  let body;
  try {
    body = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const failed = [];
  for (const line of body.split("\n")) {
    const match = /^\s*not ok \d+ - (.+?)\s*$/.exec(line);
    // TAP escapes `#` and `\` in a description. Nearly every test in this repo
    // carries a `(#nnn)` ticket reference, so reading the escaped form literally
    // would fail to match its block and report the whole surface as "outside"
    // it — the parser silently answering the wrong question.
    if (match) failed.push(match[1].replace(/\\(.)/g, "$1"));
  }
  return { failed, total: (body.match(/^\s*(not )?ok \d+ - /gm) ?? []).length };
}

// What the run actually did to each failing test, decided by evidence.
function classify(name, blocks, artifacts) {
  const block = blocks.find((entry) => entry.title === name);
  if (!block) {
    // A file path, a hook, or a test that drives no browser.
    return { name, verdict: "outside the browser wait surface", detail: null };
  }
  const artifact = block.label === null ? null : `${block.label}.json`;
  if (artifact !== null && artifacts.includes(artifact)) {
    return { name, verdict: "recorder ATTACHED and wrote", detail: artifact };
  }
  if (artifact !== null && artifacts.includes(`${UNATTACHED_PREFIX}${artifact}`)) {
    return {
      name,
      verdict: "NOT attached — it threw before a recorder reached a page",
      detail: `${UNATTACHED_PREFIX}${artifact}`
    };
  }
  return {
    name,
    verdict: "NOT attached — no record at all: it failed before its catch (fixture setup, browser launch, or a path outside the wired try)",
    detail: null
  };
}

export async function buildStatus(dir) {
  const artifacts = await listArtifacts(dir);
  const inventory = surveyBrowserWaitSurface(repoRoot);
  const blocks = inventory.flatMap((entry) =>
    entry.blocks.map((block) => ({ ...block, file: entry.file }))
  );
  const covered = inventory.reduce((sum, entry) => sum + entry.covered, 0);
  const uncovered = [
    ...inventory.flatMap((entry) => entry.uncovered.map((block) => `${entry.file}:${block.line} — ${block.title}`)),
    // A helper that drives a browser and writes nothing is the same gap wearing
    // a function name (@re2, PR #304).
    ...inventory.flatMap((entry) =>
      entry.uncoveredHelpers.map((helper) => `${entry.file}:${helper.line} — helper ${helper.name}()`)
    )
  ];
  const excepted = inventory.flatMap((entry) =>
    entry.excepted.map((block) => `${entry.file}:${block.line} — ${block.title} (exception: ${block.exception})`)
  );
  const run = await readFailedTests(RUN_RECORD);
  const attached = artifacts.filter((name) => !name.startsWith(UNATTACHED_PREFIX));
  const unattached = artifacts.filter((name) => name.startsWith(UNATTACHED_PREFIX));

  const lines = [
    "# Browser failure diagnostics — attachment status (#303)",
    "",
    `- run record: **${run === null ? "absent" : `${run.total} results, ${run.failed.length} failed`}**`,
    `- artifacts from an attached recorder: **${attached.length}**`,
    `- artifacts recording a failure with NO recorder attached: **${unattached.length}**`,
    `- browser test blocks in the 30s wait surface: **${blocks.length}**`,
    `- blocks carrying attach-and-write code: **${covered}**`,
    `- blocks with a documented exception: **${excepted.length}**`,
    `- blocks with neither: **${uncovered.length}**`,
    ""
  ];

  if (run === null) {
    lines.push(
      "**The suite did not run.** No run record was produced, so this job failed",
      "before the tests started — lint, typecheck, install — and no statement about",
      "recorder attachment is possible or needed.",
      ""
    );
  } else if (run.failed.length === 0) {
    lines.push(
      "**No test reported a failure.** The job failed outside the test run (a later",
      "gate, or the runner itself). Nothing here says anything about the recorder.",
      ""
    );
  } else {
    lines.push("**What the run did, per failing test:**", "");
    for (const result of run.failed.map((name) => classify(name, blocks, artifacts))) {
      lines.push(`- \`${result.name}\` — ${result.verdict}${result.detail === null ? "" : ` (\`${result.detail}\`)`}`);
    }
    lines.push("");
    if (unattached.length > 0 || run.failed.some((name) => classify(name, blocks, artifacts).verdict.startsWith("NOT attached"))) {
      lines.push(
        "A **NOT attached** verdict is the state #303 exists to expose: the failure is",
        "real and the recorder never saw it, so the absence of a trace is a property of",
        "where the failure happened — not evidence that the run was quiet.",
        ""
      );
    }
  }

  if (attached.length + unattached.length > 0) {
    lines.push("Files in this artifact:", "");
    for (const name of artifacts) lines.push(`- \`${name}\``);
    lines.push("");
  }

  if (uncovered.length > 0) {
    lines.push("Blocks in the surface that carry no failure writer at all:", "");
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
