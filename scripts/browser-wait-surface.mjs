// #303 — the coverage rule, expressed once and read by everything that needs it.
//
// #289 wired the recorder into the files a census of past failures implicated.
// The next 30-second failure (#248, run 31026009385) landed in a file that census
// never named, and produced nothing. So coverage is defined here by the WAIT
// SURFACE — every browser test block that can sit on a 30s ceiling — and not by
// which files have failed before.
//
// A block is in the surface if it drives a browser at all: it launches one, opens
// a page, or uses a fixture page. Every such block must reach a `diagnostics`
// write on failure, or be listed in EXCEPTIONS with a stated reason.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// Concrete, per-block reasons a candidate cannot use the recorder. Empty today:
// every block in the surface is wired. A future entry must name the block and the
// technical reason, not its size or its failure history.
export const EXCEPTIONS = [];

const WAIT_CALL = /\.(waitFor|waitForSelector|waitForFunction|waitForEvent|waitForURL|waitForResponse|waitForRequest|waitForLoadState|waitForTimeout)\(/g;
// Direct evidence a block drives a browser. `\bpage\.` alone is not enough, and
// deliberately so: @re2 found a block whose three browser sessions all live in a
// helper it calls, so it names no page and was dropped from the inventory
// ENTIRELY — not reported uncovered, absent. Reaching a browser helper counts as
// driving a browser (see `browserHelpers`).
const DRIVES_BROWSER = /chromium\.launch|\.newPage\(|\bpage\b|fixture\.diagnostics/;

// The title this block will carry AT RUNTIME (#318).
//
// This used to be the raw source slice between the quotes. A title spelled
// `record\'s` in the source is `record's` when node runs it, so the two never
// matched, and `diagnostics-attachment-status` reported an INSTRUMENTED failure as
// outside the wait surface while the recorder's own artifact sat in the same
// output — the instrument lying about its own coverage, which is the #293 class of
// defect one level up.
//
// The fix is to parse the literal rather than to unescape it. TypeScript's `.text`
// on a string or no-substitution template literal IS the parsed value, so `\'`,
// `\n`, `é`, `\x41` and a backtick-quoted title all resolve exactly as the
// runtime resolves them — including the spelling nobody has written yet, which is
// the part a hand-written unescaper can never promise.
//
// Returns null when the first argument is not a single literal (a template with a
// substitution, a concatenation, a variable). Those have no fixed runtime name to
// match, and inventing one would be a different way of guessing.
function runtimeTitle(text) {
  const parsed = ts.createSourceFile("block.ts", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const [statement] = parsed.statements;
  if (statement === undefined || !ts.isExpressionStatement(statement)) return null;
  const call = statement.expression;
  if (!ts.isCallExpression(call)) return null;
  const [first] = call.arguments;
  if (first === undefined) return null;
  return ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) ? first.text : null;
}

// Split a test file into its top-level `test(...)` blocks. A block runs from the
// line beginning `test(` to the next line that is exactly `});`.
export function testBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("test(")) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end] !== "});") end += 1;
    const text = lines.slice(i, Math.min(end + 1, lines.length)).join("\n");
    blocks.push({
      title: runtimeTitle(text) ?? `<unnamed at line ${i + 1}>`,
      line: i + 1,
      text
    });
    i = end + 1;
  }
  return blocks;
}

// A wait that carries an explicit sub-30s timeout cannot consume the standard
// ceiling; everything else can. Counted for the inventory only — coverage does
// not depend on the count, or a block with one wait would look safer than a
// block with ten, which is the reasoning that left #248 uninstrumented.
function countCeilingWaits(text) {
  let total = 0;
  for (const match of text.matchAll(WAIT_CALL)) {
    const tail = text.slice(match.index, match.index + 400);
    const explicit = /timeout:\s*([\d_]+)/.exec(tail);
    if (explicit && Number(explicit[1].replace(/_/g, "")) < 30_000) continue;
    total += 1;
  }
  return total;
}

function attaches(text) {
  return /recordBrowserDiagnostics\(|fixture\.diagnostics/.test(text);
}

// The failure path itself: a `catch (error)` that writes an artifact and rethrows
// the original error untouched.
function writesOnFailure(text) {
  for (const match of text.matchAll(/\} catch \(error\) \{/g)) {
    const clause = text.slice(match.index, match.index + 400);
    if (/\.write\(|captureBrowserFailure\(/.test(clause) && /throw error;/.test(clause)) return true;
  }
  return false;
}

// Every top-level function in the file that launches a browser or opens a page,
// with the same attach-and-write test a test block gets. A helper is a browser
// session that happens to have a name: `offlineNotice` ran three of them, held
// three ceiling waits, and was outside the denominator because it is not spelled
// `test(` and not spelled `startFixture`. Matching on `chromium.launch(` rather
// than on a naming convention is the point — a convention is what missed it.
export function browserHelpers(source) {
  const lines = source.split("\n");
  const candidates = [];
  for (let i = 0; i < lines.length; i += 1) {
    const name = /^(?:export )?(?:async )?function (\w+)/.exec(lines[i])?.[1] ?? /^(?:export )?const (\w+) = async/.exec(lines[i])?.[1];
    if (name === undefined) continue;
    let end = i + 1;
    while (end < lines.length && lines[end] !== "}" && lines[end] !== "};") end += 1;
    candidates.push({ name, line: i + 1, text: lines.slice(i, end + 1).join("\n") });
  }

  // Transitively (@re2, PR #304): a helper that only takes its page FROM another
  // helper contains neither `chromium.launch(` nor `newPage(`, so a direct test
  // misses it — `startMixedFixture` reloads that page and waits on a 30s ceiling,
  // and every caller invokes it before its own try. One hop is not a special
  // case, so this closes over as many hops as the file has.
  const selected = new Map();
  for (;;) {
    const before = selected.size;
    for (const candidate of candidates) {
      if (selected.has(candidate.name)) continue;
      const direct = /chromium\.launch\(|\.newPage\(/.test(candidate.text);
      const viaHelper = [...selected.keys()].some((known) => new RegExp(`\\b${known}\\(`).test(candidate.text));
      if (direct || viaHelper) selected.set(candidate.name, candidate);
    }
    if (selected.size === before) break;
  }

  return [...selected.values()]
    .sort((a, b) => a.line - b.line)
    .map((helper) => ({
      name: helper.name,
      line: helper.line,
      text: helper.text,
      waits: countCeilingWaits(helper.text),
      covered: attaches(helper.text) && writesOnFailure(helper.text),
      label: /(?:\.write|captureBrowserFailure)\(\s*(?:[^,)]+,\s*)?[`"]([^`"]+)/.exec(helper.text)?.[1] ?? null
    }));
}

// Does a `start…Fixture` helper launch the browser itself? Those files hold the
// page inside the fixture, so the fixture's own readiness waits run before any
// test body — and a failure there is exactly the one that produces nothing. The
// body is read to its own closing brace at column 0; a regex spanning the whole
// file would find a `chromium.launch(` in some later test and report every file
// as fixture-launching.
function fixtureLaunchesBrowser(source) {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^(export )?async function start\w*Fixture\b/.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && lines[end] !== "}") end += 1;
    if (lines.slice(i, end).join("\n").includes("chromium.launch(")) return true;
  }
  return false;
}

// The surface is every test file that DRIVES a browser, found by its playwright
// import rather than by a `browser-` filename. Two e2e files drive one and are
// named neither way; a name-based rule would have declared full coverage while
// leaving them out — the same reasoning that left #248 uninstrumented, one level
// up.
function browserTestFiles(repoRoot, dir = path.join(repoRoot, "test"), found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      browserTestFiles(repoRoot, full, found);
      continue;
    }
    if (!entry.name.endsWith(".test.ts")) continue;
    if (!/from "playwright"/.test(readFileSync(full, "utf8"))) continue;
    found.push(path.relative(path.join(repoRoot, "test"), full));
  }
  return found;
}

export function surveyBrowserWaitSurface(repoRoot) {
  const testDir = path.join(repoRoot, "test");
  const files = browserTestFiles(repoRoot);

  const inventory = [];
  for (const name of files) {
    const source = readFileSync(path.join(testDir, name), "utf8");
    const helpers = browserHelpers(source);
    // A block that calls a browser helper drives a browser, even though it names
    // no page of its own.
    const reachesHelper = (text) => helpers.some((helper) => new RegExp(`\\b${helper.name}\\(`).test(text));
    const blocks = [];
    for (const block of testBlocks(source)) {
      if (!DRIVES_BROWSER.test(block.text) && !reachesHelper(block.text)) continue;
      const exception = EXCEPTIONS.find((entry) => entry.file === name && entry.title === block.title);
      blocks.push({
        title: block.title,
        line: block.line,
        waits: countCeilingWaits(block.text),
        // Attached AND written on failure. A recorder that is created and never
        // written when the test throws is the same silence with more code, and a
        // catch that writes without rethrowing would convert a failure into a
        // pass — so both halves are checked, not just the import.
        // A block whose only browser session lives in a helper is covered by that
        // helper's own attach-and-write, not by code the block does not contain.
        // "Opens its own session" is decided by `chromium.launch(`/`newPage(` and
        // not by the looser inventory test, so the word "page" in a comment
        // cannot make a block look like it holds a session it does not.
        covered:
          (attaches(block.text) && writesOnFailure(block.text)) ||
          (!/chromium\.launch\(|\.newPage\(/.test(block.text) &&
            reachesHelper(block.text) &&
            helpers.every((helper) => !new RegExp(`\\b${helper.name}\\(`).test(block.text) || helper.covered)),
        // The artifact name this block writes under, so a failing test reported
        // by the run can be matched to the record it should have produced.
        label: /(?:\.write|captureBrowserFailure)\((?:[^,)]+,\s*)?"([^"]+)"/.exec(block.text)?.[1] ?? null,
        exception: exception?.reason ?? null
      });
    }
    // Fixture setup runs before any test body, so its own waits are part of the
    // surface too — and they are the ones that produce nothing when they fail.
    const setupCovered = /diagnostics\.write\("[^"]*fixture-setup"/.test(source);
    inventory.push({
      file: name,
      blocks,
      helpers,
      uncoveredHelpers: helpers.filter((helper) => !helper.covered),
      waits: blocks.reduce((sum, block) => sum + block.waits, 0) + helpers.reduce((sum, helper) => sum + helper.waits, 0),
      covered: blocks.filter((block) => block.covered).length,
      uncovered: blocks.filter((block) => !block.covered && block.exception === null),
      excepted: blocks.filter((block) => !block.covered && block.exception !== null),
      launchesInFixture: fixtureLaunchesBrowser(source),
      setupCovered
    });
  }
  return inventory;
}

export function formatInventory(inventory) {
  const rows = [
    "| file | browser blocks | covered | browser helpers | covered | 30s-ceiling waits | fixture setup wired |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |"
  ];
  for (const entry of inventory) {
    const setup = entry.launchesInFixture ? (entry.setupCovered ? "yes" : "NO") : "n/a";
    const helpersCovered = entry.helpers.filter((helper) => helper.covered).length;
    rows.push(
      `| \`${entry.file}\` | ${entry.blocks.length} | ${entry.covered} | ${entry.helpers.length} | ${helpersCovered} | ${entry.waits} | ${setup} |`
    );
  }
  const totals = inventory.reduce(
    (acc, entry) => ({
      blocks: acc.blocks + entry.blocks.length,
      covered: acc.covered + entry.covered,
      helpers: acc.helpers + entry.helpers.length,
      helpersCovered: acc.helpersCovered + entry.helpers.filter((helper) => helper.covered).length,
      waits: acc.waits + entry.waits
    }),
    { blocks: 0, covered: 0, helpers: 0, helpersCovered: 0, waits: 0 }
  );
  rows.push(
    `| **total** | **${totals.blocks}** | **${totals.covered}** | **${totals.helpers}** | **${totals.helpersCovered}** | **${totals.waits}** | |`
  );
  return rows.join("\n");
}

if (import.meta.filename === process.argv[1]) {
  // An explicit root is how the coverage test drives this over a synthetic tree:
  // proving the guard reports a gap needs a tree that HAS one.
  const repoRoot = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
  const inventory = surveyBrowserWaitSurface(repoRoot);
  console.log(formatInventory(inventory));
  const gaps = inventory.flatMap((entry) =>
    entry.uncovered.map((block) => `${entry.file}:${block.line} ${block.title}`)
  );
  const setupGaps = inventory
    .filter((entry) => entry.launchesInFixture && !entry.setupCovered)
    .map((entry) => `${entry.file}: startFixture launches a browser but its own waits write nothing`);
  const helperGaps = inventory.flatMap((entry) =>
    entry.uncoveredHelpers.map(
      (helper) => `${entry.file}:${helper.line} helper ${helper.name}() drives a browser and writes nothing on failure`
    )
  );
  if (gaps.length > 0 || setupGaps.length > 0 || helperGaps.length > 0) {
    console.error("\nUNCOVERED:");
    for (const gap of [...gaps, ...helperGaps, ...setupGaps]) console.error("  - " + gap);
    process.exit(1);
  }
}
