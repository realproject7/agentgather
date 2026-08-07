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

// Concrete, per-block reasons a candidate cannot use the recorder. Empty today:
// every block in the surface is wired. A future entry must name the block and the
// technical reason, not its size or its failure history.
export const EXCEPTIONS = [];

const WAIT_CALL = /\.(waitFor|waitForSelector|waitForFunction|waitForEvent|waitForURL|waitForResponse|waitForRequest|waitForLoadState|waitForTimeout)\(/g;
const DRIVES_BROWSER = /chromium\.launch|\.newPage\(|\bpage\.|fixture\.page/;

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
      title: /^test\(\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? `<unnamed at line ${i + 1}>`,
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
    if (/\.write\(/.test(clause) && /throw error;/.test(clause)) return true;
  }
  return false;
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
    const blocks = [];
    for (const block of testBlocks(source)) {
      if (!DRIVES_BROWSER.test(block.text)) continue;
      const exception = EXCEPTIONS.find((entry) => entry.file === name && entry.title === block.title);
      blocks.push({
        title: block.title,
        line: block.line,
        waits: countCeilingWaits(block.text),
        // Attached AND written on failure. A recorder that is created and never
        // written when the test throws is the same silence with more code, and a
        // catch that writes without rethrowing would convert a failure into a
        // pass — so both halves are checked, not just the import.
        covered: attaches(block.text) && writesOnFailure(block.text),
        exception: exception?.reason ?? null
      });
    }
    // Fixture setup runs before any test body, so its own waits are part of the
    // surface too — and they are the ones that produce nothing when they fail.
    const setupCovered = /diagnostics\.write\("[^"]*fixture-setup"/.test(source);
    inventory.push({
      file: name,
      blocks,
      waits: blocks.reduce((sum, block) => sum + block.waits, 0),
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
    "| file | browser blocks | covered | 30s-ceiling waits | fixture setup wired |",
    "| --- | ---: | ---: | ---: | --- |"
  ];
  for (const entry of inventory) {
    const setup = entry.launchesInFixture ? (entry.setupCovered ? "yes" : "NO") : "n/a";
    rows.push(`| \`${entry.file}\` | ${entry.blocks.length} | ${entry.covered} | ${entry.waits} | ${setup} |`);
  }
  const totals = inventory.reduce(
    (acc, entry) => ({
      blocks: acc.blocks + entry.blocks.length,
      covered: acc.covered + entry.covered,
      waits: acc.waits + entry.waits
    }),
    { blocks: 0, covered: 0, waits: 0 }
  );
  rows.push(`| **total** | **${totals.blocks}** | **${totals.covered}** | **${totals.waits}** | |`);
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
  if (gaps.length > 0 || setupGaps.length > 0) {
    console.error("\nUNCOVERED:");
    for (const gap of [...gaps, ...setupGaps]) console.error("  - " + gap);
    process.exit(1);
  }
}
