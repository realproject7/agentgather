// #303 — the coverage rule, and the attachment-status signal, tested against
// what they actually produce.
//
// #289 chose which files to instrument from a census of past failures. The next
// 30-second failure landed in a file that census had never named and published
// nothing, so the rule here is the WAIT SURFACE: every browser test block that
// can sit on a 30s ceiling writes an artifact when it throws, or is listed as an
// explicit exception. That is a property of the tree, so it is checked by
// running the same script CI runs — not by re-implementing the rule here, which
// would only prove this file agrees with itself.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const surveyScript = path.join(repoRoot, "scripts", "browser-wait-surface.mjs");
const statusScript = path.join(repoRoot, "scripts", "diagnostics-attachment-status.mjs");

type RunResult = { code: number | null; stdout: string; stderr: string };

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// A minimal tree the survey can read: one block wired the way the real ones are,
// one that only opens a page. The sample lives in `test/support/` as `.txt` —
// inline here, its playwright import would make THIS file look like a browser
// test to the survey it is checking, and the guard would report its own fixture.
async function syntheticTree(): Promise<string> {
  const sample = await readFile(path.join(repoRoot, "test", "support", "wait-surface-sample.txt"), "utf8");
  // Positive control on the fixture itself: a sample that lost its unwired block
  // would make the guard-fails test below vacuous.
  assert.match(sample, /test\("an unwired block"/);
  assert.match(sample, /test\("a wired block"/);
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-wait-surface-fixture-"));
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, "test", "browser-fixture-sample.test.ts"), sample, "utf8");
  return root;
}

test("every browser test block in the 30s wait surface writes a diagnostic on failure (#303)", async () => {
  const result = await run([surveyScript]);
  assert.equal(
    result.code,
    0,
    `the wait surface has uncovered blocks:\n${result.stderr}\n${result.stdout}`
  );

  // POSITIVE CONTROL on the instrument, not on the tree: a survey that found no
  // blocks at all would also exit 0, and an empty inventory is the reassuring
  // shape of a broken scanner. The real tree has many blocks and many waits.
  const total = /\| \*\*total\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\*/.exec(result.stdout);
  assert.ok(total, `the inventory must report a total row:\n${result.stdout}`);
  const [, blocks, covered, waits] = total;
  assert.ok(Number(blocks) > 100, `expected the real browser surface, got ${blocks} blocks`);
  assert.equal(covered, blocks, "every block in the surface must be covered");
  assert.ok(Number(waits) > 100, `expected the real wait surface, got ${waits} waits`);
});

test("the coverage guard FAILS on a block that opens a page and writes nothing (#303)", async () => {
  // The control for the test above: without this, "exit 0" would be equally
  // consistent with a guard that can never fail — the instrument failure this
  // project keeps meeting in the reassuring direction.
  const root = await syntheticTree();
  const result = await run([surveyScript, root]);
  assert.equal(result.code, 1, "an uncovered block must fail the guard");
  assert.match(result.stderr, /UNCOVERED:/);
  assert.match(result.stderr, /an unwired block/);
  assert.equal(/- .*a wired block/.test(result.stderr), false, "the wired block must not be reported");
});

test("a failed run with no artifact states that the recorder was attached and quiet (#303)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agentgather-attachment-status-quiet-"));
  const result = await run([statusScript], { cwd: workspace });
  assert.equal(result.code, 0, result.stderr);

  const written = await readFile(path.join(workspace, "test-artifacts", "attachment-status.md"), "utf8");
  assert.match(written, /diagnostic artifacts written this run: \*\*0\*\*/);
  assert.match(written, /The recorder was attached and quiet/);
  assert.match(written, /blocks with neither: \*\*0\*\*/);
  // The upload step is `if-no-files-found: error`, which is only safe because
  // this file always exists on a failed run.
  assert.ok(written.length > 200, "the status must be a real report, not an empty file");
  // Credential-free by construction: it reports names and counts, never contents.
  assert.equal(/tgl_[A-Za-z0-9]|Bearer\s|token=/i.test(written), false, "the status must carry nothing credential-shaped");
});

test("a failed run WITH artifacts names them, and nothing else (#303)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agentgather-attachment-status-wrote-"));
  await mkdir(path.join(workspace, "test-artifacts"), { recursive: true });
  // Contents that would be catastrophic to echo. The status must name the file
  // and never read it.
  await writeFile(
    path.join(workspace, "test-artifacts", "a-failing-lifecycle-test.json"),
    JSON.stringify({ label: "x", failure: "tgl_never_echo_this_secret" }),
    "utf8"
  );
  const result = await run([statusScript], { cwd: workspace });
  assert.equal(result.code, 0, result.stderr);

  const written = await readFile(path.join(workspace, "test-artifacts", "attachment-status.md"), "utf8");
  assert.match(written, /diagnostic artifacts written this run: \*\*1\*\*/);
  assert.match(written, /The recorder attached and wrote/);
  assert.match(written, /a-failing-lifecycle-test\.json/);
  assert.equal(written.includes("tgl_never_echo_this_secret"), false, "the status must not read artifact contents");
});

test("the status names the uncovered blocks when the recorder is NOT attached (#303)", async () => {
  // The third branch, and the one that cannot be produced from the real tree
  // because the tree is fully covered. Driven over the synthetic tree so the
  // prose is proven reachable rather than assumed.
  const root = await syntheticTree();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agentgather-attachment-status-gap-"));
  const result = await run([statusScript], { cwd: workspace, env: { BROWSER_SURFACE_ROOT: root } });
  assert.equal(result.code, 0, result.stderr);

  const written = await readFile(path.join(workspace, "test-artifacts", "attachment-status.md"), "utf8");
  assert.match(written, /The recorder was NOT attached everywhere/);
  assert.match(written, /an unwired block/);
  assert.match(written, /blocks with neither: \*\*1\*\*/);
});

test("a green run publishes no artifact and no status noise (#303)", async () => {
  // The status script is the only writer outside a failure path, and CI runs it
  // under `if: failure()`. Nothing here may write on its own: this asserts the
  // recorder module's own promise — attaching costs memory, not files.
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agentgather-green-run-"));
  const probe = path.join(workspace, "probe.mjs");
  await writeFile(
    probe,
    [
      `import { chromium } from "${path.join(repoRoot, "node_modules", "playwright", "index.mjs")}";`,
      `import { recordBrowserDiagnostics } from "${path.join(repoRoot, "dist", "test", "support", "browser-diagnostics.js")}";`,
      "const browser = await chromium.launch();",
      "const page = await browser.newPage();",
      "const diagnostics = recordBrowserDiagnostics(page, page.context());",
      'await page.goto("about:blank");',
      'diagnostics.mark("a run that passes");',
      "await browser.close();",
      // Positive control: the recorder really did observe the session, so "no
      // files written" is a statement about a live recorder rather than a dead one.
      "console.log(JSON.stringify({ events: diagnostics.events().length }));"
    ].join("\n"),
    "utf8"
  );
  const result = await run([probe], { cwd: workspace });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).events > 0, "the recorder must have been live");

  await assert.rejects(
    () => readFile(path.join(workspace, "test-artifacts", "attachment-status.md"), "utf8"),
    /ENOENT/,
    "a passing run must write no artifact directory at all"
  );
});
