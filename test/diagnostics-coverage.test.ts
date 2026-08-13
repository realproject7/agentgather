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
  assert.match(sample, /async function unwiredHelperSession/);
  assert.match(sample, /test\("a block that only reaches a browser through a helper"/);
  // One hop further: a helper that takes its page FROM another helper names no
  // browser of its own, which is the shape @re2 found in `startMixedFixture`.
  assert.match(sample, /async function unwiredIndirectSession/);
  assert.match(sample, /test\("a block that reaches a browser two hops away"/);
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
  const total =
    /\| \*\*total\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\*/.exec(result.stdout);
  assert.ok(total, `the inventory must report a total row:\n${result.stdout}`);
  const [, blocks, covered, helpers, helpersCovered, waits] = total;
  assert.ok(Number(helpers) > 0, "browser helpers are part of the denominator");
  assert.equal(helpersCovered, helpers, "every browser helper must attach and write too");
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

test("the guard catches a browser session that lives in a HELPER, not a block (#303)", async () => {
  // @re2 on PR #304: `offlineNotice()` ran three browser sessions and held three
  // ceiling waits, and the block calling it named no page — so a denominator
  // built from "does this block mention a page" dropped it from the inventory
  // entirely. Absent is worse than uncovered: the guard reported full coverage.
  const root = await syntheticTree();
  const result = await run([surveyScript, root]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /helper unwiredHelperSession\(\) drives a browser and writes nothing/);
  // Transitive: a helper whose page comes from another helper is a browser
  // helper too, and so is the block that calls it.
  assert.match(result.stderr, /helper unwiredIndirectSession\(\) drives a browser and writes nothing/);
  assert.match(result.stderr, /a block that only reaches a browser through a helper/);
  assert.match(result.stderr, /a block that reaches a browser two hops away/);
  // …while the helper that DOES attach and write is not flagged — a guard that
  // reported every helper would pass this test while being useless.
  assert.equal(/helper wiredHelperSession\(\)/.test(result.stderr), false, "a covered helper must not be flagged");
  assert.match(result.stdout, /\| 4 \| 1 \| 3 \| 1 \|/, `blocks and helpers must both be counted:\n${result.stdout}`);
});

// #322 — a browser block whose title cannot be resolved to a runtime name.
//
// #318 stopped a RESOLVABLE title from being misread. This is the other route to
// the same false sentence: a block that is fully wired, writes its artifact, and
// still has its failure classified as outside the wait surface, because the status
// matches a failing test by name and this block has none to match.
test("the guard FAILS on a browser block whose title cannot be resolved, and says where (#322)", async () => {
  const fixture = await readFile(path.join(repoRoot, "test", "support", "wait-surface-dynamic-title.txt"), "utf8");
  // Positive controls on the fixture: without each of these the assertions below
  // would prove nothing.
  assert.match(fixture, /test\(ASSEMBLED_TITLE, async/, "the fixture lost its variable-titled block");
  assert.match(fixture, /test\(`\$\{ASSEMBLED_TITLE\} in a template/, "the fixture lost its template-titled block");
  assert.match(fixture, /test\("a normally titled covered block \(#322\)"/, "the fixture lost its named control");
  assert.match(fixture, /with no browser at all/, "the fixture lost its non-browser block");
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-dynamic-title-fixture-"));
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, "test", "browser-dynamic-sample.test.ts"), fixture, "utf8");

  const result = await run([surveyScript, root]);
  assert.equal(result.code, 1, `an unresolvable title must fail the guard:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /UNRESOLVED TITLE:/);

  // LOCATED, not counted. "2 titles unresolved" sends the reader looking; naming
  // the file and line is what makes it actionable.
  assert.match(result.stderr, /browser-dynamic-sample\.test\.ts:17 a browser block whose title is not a single literal/);
  assert.match(result.stderr, /browser-dynamic-sample\.test\.ts:34 a browser block whose title is not a single literal/);

  // Assert the reported SET, by line, not the absence of a title string: the
  // message deliberately carries no title (an unresolved block has none), so an
  // assertion phrased as "the named block is absent from stderr" could never fail
  // and would be worth nothing.
  //
  // Line 52 is the normally titled covered block and line 71 is a dynamic title
  // with no browser. Both are in the same fixture and neither may be reported:
  // 52 keeps "exit 1 on a gap" from being satisfied by a guard that flags every
  // block it sees, and 71 keeps it from firing outside the wait surface, where it
  // would be a nuisance and get switched off.
  const reported = result.stderr
    .split("UNRESOLVED TITLE:")[1]
    ?.split("\n")
    .filter((line) => line.trimStart().startsWith("- "))
    .map((line) => /browser-dynamic-sample\.test\.ts:(\d+)/.exec(line)?.[1] ?? line.trim());
  assert.deepEqual(reported, ["17", "34"], `only the two unresolvable titles may be reported:\n${result.stderr}`);

  // The two failures are independent: these blocks ARE covered. Reporting them as
  // uncovered would be a different, wrong diagnosis of the same source line.
  assert.match(result.stdout, /\| 3 \| 3 \| 0 \| 0 \|/, `the surface blocks are covered:\n${result.stdout}`);
  assert.equal(/UNCOVERED:/.test(result.stderr), false, "an unresolved title is not a coverage gap");
});

test("a tree whose titles all resolve produces no unresolved-title warning at all (#322)", async () => {
  // The negative control for the test above: without it, a guard that warned
  // unconditionally would pass every assertion there. Driven over the REAL tree,
  // which is the population the guard actually runs against.
  const result = await run([surveyScript]);
  assert.equal(result.code, 0, `the real tree must stay clean:\n${result.stderr}`);
  assert.equal(/UNRESOLVED TITLE/.test(result.stderr), false, `no warning is due:\n${result.stderr}`);
  assert.equal(/UNRESOLVED TITLE/.test(result.stdout), false, "the inventory must stay quiet too");
  assert.equal(/<unnamed at line/.test(result.stdout), false, "no block in the real surface is unnamed");
});

// A run record in the form node:test emits, so the status is driven by what the
// run actually reported rather than by what the sources contain.
async function runRecord(workspace: string, failing: string[], passing = 1): Promise<void> {
  const lines: string[] = ["TAP version 13"];
  let n = 0;
  // TAP escapes `#` and `\` in a description, and nearly every test here carries
  // a `(#nnn)` reference — so the fixture escapes too. Written unescaped, these
  // tests would pass against a reader that cannot parse the real thing.
  const tap = (name: string): string => name.replace(/([#\\])/g, "\\$1");
  for (let i = 0; i < passing; i += 1) lines.push(`ok ${(n += 1)} - a test that passed ${i}`);
  for (const name of failing) lines.push(`not ok ${(n += 1)} - ${tap(name)}`);
  await writeFile(path.join(workspace, "test-run.tap"), `${lines.join("\n")}\n`, "utf8");
}

test("with no run record at all, the status says the suite did not run (#303)", async () => {
  // A job that dies in lint or typecheck never reaches the tests. Saying
  // anything about the recorder there would be a claim with no evidence behind
  // it — which is the whole finding this rewrite answers (@re1, PR #304).
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agentgather-status-no-run-"));
  const result = await run([statusScript], { cwd: workspace });
  assert.equal(result.code, 0, result.stderr);

  const written = await readFile(path.join(workspace, "test-artifacts", "attachment-status.md"), "utf8");
  assert.match(written, /run record: \*\*absent\*\*/);
  assert.match(written, /The suite did not run/);
  assert.equal(/attached and quiet/i.test(written), false, "no attachment claim is possible without a run");
  // The upload step is `if-no-files-found: error`, which is only safe because
  // this file always exists on a failed run.
  assert.ok(written.length > 200, "the status must be a real report, not an empty file");
  assert.equal(/tgl_[A-Za-z0-9]|Bearer\s|token=/i.test(written), false, "nothing credential-shaped");
});

test("a failing browser test WITH its artifact reads as attached, and its contents are never echoed (#303)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agentgather-status-attached-"));
  await mkdir(path.join(workspace, "test-artifacts"), { recursive: true });
  // A real title from the surface, and the label that block writes under.
  const title = "a poll response cannot rewind the live cursor (#283)";
  await writeFile(
    path.join(workspace, "test-artifacts", "a-poll-response-cannot-rewind-the-live-cursor-28.json"),
    // Contents that would be catastrophic to echo. The status names files; it
    // must never read one.
    JSON.stringify({ label: "x", attached: true, failure: "tgl_never_echo_this_secret" }),
    "utf8"
  );
  await runRecord(workspace, [title]);
  const result = await run([statusScript], { cwd: workspace });
  assert.equal(result.code, 0, result.stderr);

  const written = await readFile(path.join(workspace, "test-artifacts", "attachment-status.md"), "utf8");
  assert.match(written, /recorder ATTACHED and wrote/);
  assert.match(written, /a-poll-response-cannot-rewind-the-live-cursor-28\.json/);
  assert.equal(written.includes("tgl_never_echo_this_secret"), false, "the status must not read artifact contents");
});

test("a failing browser test with an unattached record reads as NOT attached (#303)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agentgather-status-unattached-"));
  await mkdir(path.join(workspace, "test-artifacts"), { recursive: true });
  const title = "a poll response cannot rewind the live cursor (#283)";
  await writeFile(
    path.join(workspace, "test-artifacts", "unattached--a-poll-response-cannot-rewind-the-live-cursor-28.json"),
    JSON.stringify({ attached: false }),
    "utf8"
  );
  await runRecord(workspace, [title]);
  const result = await run([statusScript], { cwd: workspace });
  assert.equal(result.code, 0, result.stderr);

  const written = await readFile(path.join(workspace, "test-artifacts", "attachment-status.md"), "utf8");
  assert.match(written, /NOT attached — it threw before a recorder reached a page/);
  assert.equal(/attached and quiet/i.test(written), false);
  assert.match(written, /artifacts recording a failure with NO recorder attached: \*\*1\*\*/);
});

test("a failing browser test with NO record at all reads as NOT attached, not as quiet (#303)", async () => {
  // The exact case @re1 found: the failure happened before the block's catch —
  // fixture setup, `chromium.launch()`, anything outside the wired try — so
  // nothing was written. The old wording called this "attached and quiet".
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agentgather-status-norecord-"));
  const title = "a poll response cannot rewind the live cursor (#283)";
  await runRecord(workspace, [title]);
  const result = await run([statusScript], { cwd: workspace });
  assert.equal(result.code, 0, result.stderr);

  const written = await readFile(path.join(workspace, "test-artifacts", "attachment-status.md"), "utf8");
  assert.match(written, /NOT attached — no record at all/);
  assert.match(written, /fixture setup, browser launch/);
  assert.equal(/attached and quiet/i.test(written), false, "absence must never be reported as quiet");
});

test("a failing test outside the browser surface is named as such (#303)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agentgather-status-outside-"));
  await runRecord(workspace, ["cli room create writes a room directory"]);
  const result = await run([statusScript], { cwd: workspace });
  assert.equal(result.code, 0, result.stderr);

  const written = await readFile(path.join(workspace, "test-artifacts", "attachment-status.md"), "utf8");
  assert.match(written, /outside the browser wait surface/);
  assert.equal(/NOT attached/.test(written), false, "a non-browser failure says nothing about attachment");
});

test("the status names uncovered blocks AND uncovered helpers when the tree has gaps (#303)", async () => {
  // Driven over the synthetic tree: the real tree is fully covered, so this
  // branch is only reachable against a tree built to have a gap.
  const root = await syntheticTree();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agentgather-status-gap-"));
  const result = await run([statusScript], { cwd: workspace, env: { BROWSER_SURFACE_ROOT: root } });
  assert.equal(result.code, 0, result.stderr);

  const written = await readFile(path.join(workspace, "test-artifacts", "attachment-status.md"), "utf8");
  assert.match(written, /an unwired block/);
  assert.match(written, /helper unwiredHelperSession\(\)/);
  // Three blocks (unwired, helper-reached, two-hops) plus the two uncovered
  // helpers.
  assert.match(written, /blocks with neither: \*\*5\*\*/);
  assert.match(written, /helper unwiredIndirectSession\(\)/);
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
