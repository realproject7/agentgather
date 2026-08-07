// #303 acceptance: a forced failure in a NEWLY COVERED lifecycle candidate must
// produce the safe diagnostic artifact.
//
// The candidate is the #248 block in `browser-room-lifecycle` — the test that
// really did consume a 30-second ceiling in CI run 31026009385 and published
// nothing, because that file had no recorder. Asserting the wiring by reading
// the source would only prove the code is present; this runs the SHIPPED block,
// makes its awaited element never arrive, and reads what lands on disk.
//
// The block is copied out of `dist/` and mutated in a temp workspace: the source
// tree is never edited, and the artifact is written into a throwaway cwd rather
// than the repository's own `test-artifacts/`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const compiledTestDir = fileURLToPath(new URL("./", import.meta.url));
const LIFECYCLE = path.join(compiledTestDir, "browser-room-lifecycle.test.js");
// A `.mjs` neighbour: `pnpm test` globs `dist/test/**/*.js`, so a stray copy can
// never be picked up by a later run, and its relative imports still resolve
// because it sits in the directory it was copied from.
const MUTANT = path.join(compiledTestDir, "forced-failure-lifecycle.probe.mjs");
const MISSING_ELEMENT = "#agentgather-303-element-that-never-appears";

type RunResult = { code: number | null; stdout: string; stderr: string };

function run(args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // `NODE_TEST_CONTEXT` is inherited from the runner that is executing THIS
    // file; a child that sees it refuses to run its own tests ("run() is being
    // called recursively") and exits 0 — a probe that silently proves nothing.
    const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
    const child = spawn(process.execPath, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Keep the file's preamble and exactly one `test(...)` block, so the probe runs
// the one candidate rather than the whole file.
function extractBlock(source: string, titleFragment: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith("test(") && line.includes(titleFragment));
  assert.notEqual(start, -1, `the compiled lifecycle test must still contain ${titleFragment}`);
  let end = start;
  while (end < lines.length && lines[end] !== "});") end += 1;
  const firstTest = lines.findIndex((line) => line.startsWith("test("));
  return [...lines.slice(0, firstTest), ...lines.slice(start, end + 1)].join("\n");
}

test("a forced failure in the #248 lifecycle candidate produces the safe artifact (#303)", { timeout: 180_000 }, async () => {
  const original = await readFile(LIFECYCLE, "utf8");
  const block = extractBlock(original, "#248");

  // The mutation: immediately after the recorder attaches, await an element that
  // cannot exist. That is the shape of the failure this ticket is about — an
  // awaited thing that never arrives — and it exercises the block's real catch,
  // its real label, and the real writer. A short ceiling keeps the probe fast;
  // the timeout VALUE is not what is under test, the failure path is.
  // Injected AFTER entry has rendered, not at the top of the try: a probe that
  // fails before the page loads produces an artifact with no traffic in it, which
  // proves the writer runs but says nothing about a recorder that was watching a
  // live session — the #248 failure happened mid-test, with the room already up.
  assert.ok(
    block.includes("diagnostics = recordBrowserDiagnostics(page, page.context());"),
    "the candidate must still attach the recorder"
  );
  const anchor = 'await page.waitForSelector("text=Keep the selected identity honest.");';
  assert.ok(block.includes(anchor), "the candidate must still wait for entry to render");
  const mutated = block.replace(
    anchor,
    `${anchor}\n        await page.waitForSelector("${MISSING_ELEMENT}", { timeout: 2000 });`
  );
  assert.notEqual(mutated, block, "the probe must actually differ from the shipped block");
  await writeFile(MUTANT, mutated, "utf8");

  const workspace = await mkdtemp(path.join(os.tmpdir(), "agentgather-forced-failure-"));
  try {
    const result = await run(["--test", "--test-timeout=120000", MUTANT], workspace);

    // POSITIVE CONTROL on the probe itself: the run must have FAILED, and failed
    // on the injected wait. A probe that passed, or that died before reaching the
    // browser, would leave "an artifact exists" meaning nothing.
    assert.notEqual(result.code, 0, `the probe must fail:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout + result.stderr, /TimeoutError|Timeout .* exceeded/);
    assert.match(result.stdout + result.stderr, new RegExp(MISSING_ELEMENT));

    const artifacts = await readdir(path.join(workspace, "test-artifacts"));
    assert.deepEqual(
      artifacts,
      ["a-dashboard-open-re-authenticates-over-a-stale-t.json"],
      "the artifact must be written under the failing test's own label"
    );

    const artifactPath = path.join(workspace, "test-artifacts", artifacts[0] ?? "");
    const report = JSON.parse(await readFile(artifactPath, "utf8")) as {
      label: string;
      failure: string;
      durationMs: number;
      branches: { requestsIssued: number; crashed: boolean };
      overall: { requestsIssued: number; responsesSeen: number };
      events: Array<{ kind: string; detail: Record<string, unknown> }>;
    };

    // It names the failure without opening the file, and it describes a real
    // session rather than an empty shell.
    assert.equal(report.label, "a-dashboard-open-re-authenticates-over-a-stale-t");
    assert.match(report.failure, /TimeoutError/);
    assert.ok(report.durationMs > 0);
    assert.ok(report.overall.requestsIssued > 0, "the recorder must have seen the page's real traffic");
    assert.ok(report.overall.responsesSeen > 0, "…and its responses");
    assert.ok(report.events.length > 3, `the record must hold real events, got ${report.events.length}`);

    // And it is safe: this fixture authenticates with real tokens and enters over
    // a token fragment, so an unsafe recorder would leak here of all places.
    const raw = await readFile(artifactPath, "utf8");
    assert.equal(/tgl_[A-Za-z0-9_-]+/.test(raw), false, "no token-shaped value may reach the artifact");
    assert.equal(/Bearer\s+\S+/i.test(raw), false, "no bearer credential may reach the artifact");
    assert.equal(/authorization/i.test(raw), false, "no header material may reach the artifact");
    assert.equal(/[#?&]token=[^"&\s]+/i.test(raw.replace(/token=redacted/g, "")), false, "no token carrier");
    assert.equal(raw.includes(os.homedir()), false, "no filesystem path may reach the artifact");
  } finally {
    await rm(MUTANT, { force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
