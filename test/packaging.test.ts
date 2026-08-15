import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// #243: npm package assembly must be reproducible. The pack/publish lifecycle
// builds and then verifies the declared bin target, so a clean checkout cannot
// ship without `dist/src/cli/index.js`; the README must match the published npm
// state while still listing the production operator gates as not shipped.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const guardScript = path.join(repoRoot, "scripts", "check-package-bin.mjs");

type RunResult = { code: number | null; stdout: string; stderr: string };

function run(command: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function readManifest(): Promise<{ bin: Record<string, string>; scripts: Record<string, string> }> {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
}

function readmeSection(readme: string, heading: string): string {
  const start = readme.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `README is missing the "${heading}" section`);
  const body = readme.slice(start + heading.length + 3);
  const end = body.indexOf("\n## ");
  return end === -1 ? body : body.slice(0, end);
}

// #329: this line used to read "`agentgather@0.2.2` is published as the `latest`
// dist-tag", and the test asserted that literal. The two went stale together and
// silently — the README was two releases behind while the assertion passed
// BECAUSE nobody had updated it. A test that pins a fact only the registry owns
// is not a guard; it is a copy of the answer.
//
// So the contract is the lookup, not the number: the README must tell a reader
// how to ask npm, and must not answer for it. Checked against the document only
// — running `npm view` here would put a release gate on the network and make an
// offline suite fail for reasons that have nothing to do with the code.
const NPM_VERSION_LOOKUP = "npm view agentgather version";
// The first cut of this guard only rejected a pinned version when the SAME LINE
// also said `latest`, `dist-tag`, or `published`. Two independent reviews took
// it apart, and between them the failure has two halves that need one fix:
//
//   - the vocabulary is unbounded. "The npm registry currently serves
//     `agentgather@9.9.9`" says none of the three words and is exactly as stale
//     as the sentence #329 removed. Adding "serves" only moves the goalposts.
//   - the line is the wrong unit. A claim using the ORIGINAL vocabulary escapes
//     just by wrapping between the version and the claim word — and this
//     README's own npm bullet is wrapped across three lines, so that is the
//     normal shape of the text, not a contrived one.
//
// So the rule stopped asking how the version is worded or where the line breaks
// fall: a pinned `agentgather@<version>` anywhere in the README is the defect,
// whatever prose surrounds it. Nothing to dodge, nothing a line break can split.
// Safe to state that flatly because the README has no legitimate pin — and a
// future pinned install example would trip it too, deliberately. Naming a
// release in this document is the thing that goes stale, so putting one back
// should be an edit to this guard, not a quiet edit to the document.
//
// Version shape is deliberately loose: `9.9` and `9.9.9-rc.1` go stale exactly
// like `9.9.9`, and matching only the three-part form leaves a two-part pin as
// the next way through.
const PINNED_NPM_VERSION = /agentgather@\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?/;

// `npmjs` on its own so a versioned registry URL — npmjs.com/package/
// agentgather/v/0.2.2 — is caught for what it says rather than for happening to
// sit near the word `registry`. `\bnpm\b` does not match `npmjs.com`.
const NPM_MENTION = /\bnpmjs?\b|\bregistry\b/i;
// Not anchored to `agentgather@`, so it also catches a version named without the
// package prefix ("the registry currently serves 9.9.9") — dropping the prefix
// is the remaining way to state the claim. Applied only to npm/registry bullets
// inside Shipped Today, where every bullet is a release claim: elsewhere the
// README is full of `127.0.0.1:8787`, which no version shape can be told apart
// from by itself.
const BARE_VERSION = /\b\d+\.\d+(?:\.\d+)*\b/;

// The bullet, not the line, is the unit — and not the whole section either.
//
// Per line, "the registry currently serves" and the version it serves can sit
// on either side of a wrap and neither half trips the rule: the same mistake
// that let the original guard through, made again one rule over. Per section,
// any `\d+.\d+` anywhere in Shipped Today would be judged against an `npm` that
// some other bullet supplied, which is why the rule was scoped narrowly in the
// first place. Joining each `- ` item with its indented continuation lines keeps
// both properties: a claim cannot be split by a wrap, and an unrelated version
// in a neighbouring bullet stays unrelated.
function bullets(section: string): string[] {
  const items: string[] = [];
  for (const line of section.split("\n")) {
    const isContinuation = /^\s+\S/.test(line) && items.length > 0;
    if (isContinuation) items[items.length - 1] += ` ${line.trim()}`;
    else items.push(line);
  }
  return items;
}

// Three rules, because each one alone is a half-done edit that the other two
// catch: requiring the lookup passes a README that ADDS the command above the
// stale sentence; rejecting `agentgather@x.y.z` passes a version named without
// the package prefix; and both together still need the whole-file sweep, or the
// claim simply moves to another heading. Returned as a list rather than asserted
// inline so the guard can be driven against fixtures that MUST fail — an
// all-negative suite cannot tell "the rule works" from "the rule never fires".
function npmReleaseDocProblems(readme: string): string[] {
  const problems: string[] = [];
  const shipped = readmeSection(readme, "Shipped Today");

  // Whitespace-insensitive: the command may be rewrapped by an editor without
  // changing what it tells the reader to run.
  if (!shipped.replace(/\s+/g, " ").includes(NPM_VERSION_LOOKUP)) {
    problems.push(`Shipped Today must name \`${NPM_VERSION_LOOKUP}\` as the way to read the published version`);
  }

  for (const bullet of bullets(shipped)) {
    if (PINNED_NPM_VERSION.test(bullet)) continue; // reported by the whole-file rule below
    const bare = bullet.match(BARE_VERSION);
    if (bare !== null && NPM_MENTION.test(bullet)) {
      problems.push(`Shipped Today must not name a release version (${bare[0]}); the registry owns that answer`);
    }
  }

  // The claim can return anywhere in the file, not only in the section this
  // ticket found it in — and it does not have to sound like a claim to be one.
  for (const line of readme.split("\n")) {
    const pinned = line.match(PINNED_NPM_VERSION);
    if (pinned !== null) {
      problems.push(`the README must not pin a version (${pinned[0]}); the registry owns that answer: ${line.trim()}`);
    }
  }

  return problems;
}

test("the pack lifecycle builds and verifies the CLI bin before the tarball is assembled (#243)", async () => {
  const manifest = await readManifest();
  const prepack = manifest.scripts.prepack;
  assert.ok(prepack, "package.json must declare a prepack lifecycle script");
  assert.match(prepack, /build/, "prepack must build immediately before packing");
  assert.match(prepack, /check-package-bin\.mjs/, "prepack must verify the bin target after building");
});

test("the pack guard rejects a missing or empty bin target and accepts a built one (#243)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentgather-243-"));
  const target = "dist/src/cli/index.js";
  const packageJson = { name: "agentgather-pack-guard-case", version: "0.0.0", bin: { agentgather: target } };
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

  const missing = await run(process.execPath, [guardScript], dir);
  assert.equal(missing.code, 1, "the guard must fail when the bin target does not exist");
  assert.match(missing.stderr, /dist\/src\/cli\/index\.js is missing/);

  await mkdir(path.join(dir, "dist", "src", "cli"), { recursive: true });
  await writeFile(path.join(dir, target), "");
  const empty = await run(process.execPath, [guardScript], dir);
  assert.equal(empty.code, 1, "the guard must fail when the bin target is empty");
  assert.match(empty.stderr, /dist\/src\/cli\/index\.js is empty/);

  await writeFile(path.join(dir, target), "#!/usr/bin/env node\n");
  const built = await run(process.execPath, [guardScript], dir);
  assert.equal(built.code, 0, built.stderr);
  assert.equal(built.stderr, "");
});

test("the packed tarball contains the declared bin target (#243)", async () => {
  const manifest = await readManifest();
  const binTarget = manifest.bin.agentgather;
  assert.equal(binTarget, "dist/src/cli/index.js");

  const guard = await run(process.execPath, [guardScript], repoRoot);
  assert.equal(guard.code, 0, guard.stderr);

  const packed = await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], repoRoot);
  assert.equal(packed.code, 0, packed.stderr);
  const entries = JSON.parse(packed.stdout) as Array<{ name: string; files: Array<{ path: string }> }>;
  const entry = entries[0];
  assert.ok(entry, "npm pack --json must describe the packed tarball");
  assert.equal(entry.name, "agentgather");
  const packedPaths = entry.files.map((file) => file.path);
  assert.ok(packedPaths.includes(binTarget), `the tarball must contain ${binTarget}`);
});

test("the README reports the published npm release and keeps the production operator gates unshipped (#243, #329)", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

  const shipped = readmeSection(readme, "Shipped Today");
  assert.match(shipped, /npm/i, "Shipped Today must record the npm release");
  assert.deepEqual(npmReleaseDocProblems(readme), [], "the README must discover the published version, not pin it");

  const roadmap = readmeSection(readme, "Roadmap, Not Shipped Yet");
  assert.match(
    roadmap,
    /production `agentgather\.dev` operator gates/,
    "the production operator gates must remain listed as not shipped"
  );
  assert.doesNotMatch(roadmap, /npm publish/i, "the roadmap must no longer claim npm publish is unshipped");
});

test("the npm-release doc guard rejects a pinned version, a half-done edit, and a missing lookup (#329)", () => {
  const fixture = (bullet: string): string =>
    `# Agent Gather\n\n## Shipped Today\n\n${bullet}\n\n## Roadmap, Not Shipped Yet\n\n- nothing here\n`;
  const lookup = `- npm release: published on npm as \`agentgather\`. To see what the registry currently serves as \`latest\`, run \`${NPM_VERSION_LOOKUP}\``;
  // The exact wording this repository carried from v0.2.2 until #329.
  const stale = "- npm release: `agentgather@0.2.2` is published as the `latest` dist-tag";

  assert.deepEqual(npmReleaseDocProblems(fixture(lookup)), [], "the shipped wording must pass");
  assert.deepEqual(
    npmReleaseDocProblems(fixture(lookup.replace(/\s+/g, "\n  "))),
    [],
    "rewrapping the command across lines must not change the verdict"
  );

  const staleOnly = npmReleaseDocProblems(fixture(stale)).join("\n");
  assert.match(staleOnly, /must name `npm view agentgather version`/, "the stale README must fail for the missing lookup");
  assert.match(staleOnly, /must not pin a version \(agentgather@0\.2\.2\)/, "the stale README must fail for the pinned version");

  // The half-done edit #329 exists to prevent: the lookup added, the stale
  // sentence left in place. Passing on this is what "require the command" alone
  // would do.
  const halfDone = npmReleaseDocProblems(fixture(`${lookup}\n${stale}`)).join("\n");
  assert.doesNotMatch(halfDone, /must name `npm view agentgather version`/, "the lookup is present in this case");
  assert.match(halfDone, /must not pin a version/, "leaving the stale sentence must still fail");

  // A version claim that returns somewhere other than Shipped Today.
  const elsewhere = npmReleaseDocProblems(
    `${fixture(lookup)}\n## Install\n\n\`agentgather@9.9.9\` is published as the \`latest\` dist-tag\n`
  ).join("\n");
  assert.match(elsewhere, /must not pin a version \(agentgather@9\.9\.9\)/, "a claim outside Shipped Today must still fail");

  const noLookup = npmReleaseDocProblems(fixture("- npm release: published on npm as `agentgather`")).join("\n");
  assert.match(noLookup, /must name `npm view agentgather version`/, "removing the lookup must fail");
});

// #329 review (RE1 and RE2, same P1 from two directions): the first guard only
// rejected a pinned version when the line also said `latest`, `dist-tag`, or
// `published`. Every case below carries the same stale claim and got through —
// by using words the list never had, by wrapping between the pin and a word it
// did have, by sitting in a fenced block, or by naming two version parts instead
// of three. They must all fail, or the README goes stale again in a form the
// guard was never taught.
test("the npm-release doc guard rejects a pinned version whatever the wording, wrapping, or version shape (#329)", () => {
  const fixture = (bullet: string): string =>
    `# Agent Gather\n\n## Shipped Today\n\n${bullet}\n\n## Roadmap, Not Shipped Yet\n\n- nothing here\n`;
  const lookup = `- npm release: published on npm as \`agentgather\`. To see what the registry currently serves as \`latest\`, run \`${NPM_VERSION_LOOKUP}\``;

  // The exact sentence named in the review.
  const evasive = "The npm registry currently serves `agentgather@9.9.9`.";
  const outside = npmReleaseDocProblems(`${fixture(lookup)}\n## Install\n\n${evasive}\n`).join("\n");
  assert.doesNotMatch(outside, /must name `npm view agentgather version`/, "the lookup is present in this case");
  assert.match(
    outside,
    /must not pin a version \(agentgather@9\.9\.9\)/,
    "an authoritative claim that never says latest/dist-tag/published must still fail"
  );

  // Same sentence inside the section the ticket found the defect in.
  const inside = npmReleaseDocProblems(fixture(`${lookup}\n- ${evasive}`)).join("\n");
  assert.match(inside, /must not pin a version \(agentgather@9\.9\.9\)/, "the same wording must fail inside Shipped Today");

  // Other phrasings that dodge the original word list, one per line so each is
  // driven on its own rather than passing on a neighbour's failure.
  for (const wording of [
    "- npm release: current release is `agentgather@9.9.9`",
    "- npm release: `agentgather@9.9.9` is what you get today",
    "- npm release: install `agentgather@9.9.9`",
  ]) {
    assert.match(
      npmReleaseDocProblems(fixture(`${lookup}\n${wording}`)).join("\n"),
      /must not pin a version \(agentgather@9\.9\.9\)/,
      `this wording must fail: ${wording}`
    );
  }

  // RE2's cases: the claim does not have to sit on one line, or in prose, or
  // carry a three-part version. Each one is driven on its own.
  //
  // Wrapped — uses the ORIGINAL `published`/`latest`/`dist-tag` vocabulary and
  // escaped a line-based rule only because the break falls between the pin and
  // the claim word. This README's own npm bullet is wrapped, so this is the
  // ordinary shape of the text.
  const wrapped = npmReleaseDocProblems(
    `${fixture(lookup)}\n## Install\n\nThe package \`agentgather@9.9.9\` is currently\npublished as the \`latest\` dist-tag.\n`
  ).join("\n");
  assert.match(wrapped, /must not pin a version \(agentgather@9\.9\.9\)/, "a claim wrapped across two lines must fail");

  // Fenced — the version sits alone in a code block under a claim sentence.
  const fenced = npmReleaseDocProblems(
    `${fixture(lookup)}\n## Install\n\nThe current release is:\n\n\`\`\`\nagentgather@9.9.9\n\`\`\`\n`
  ).join("\n");
  assert.match(fenced, /must not pin a version \(agentgather@9\.9\.9\)/, "a pin inside a fenced block must fail");

  // Two-part — `9.9` goes stale exactly like `9.9.9`.
  const twoPart = npmReleaseDocProblems(
    `${fixture(lookup)}\n## Install\n\nThe npm registry currently serves \`agentgather@9.9\`.\n`
  ).join("\n");
  assert.match(twoPart, /must not pin a version \(agentgather@9\.9\)/, "a two-part version pin must fail");

  // Prerelease — the suffix must not truncate the match into something that
  // reads as a different version in the failure message.
  const prerelease = npmReleaseDocProblems(
    `${fixture(lookup)}\n## Install\n\nThe npm registry currently serves \`agentgather@9.9.9-rc.1\`.\n`
  ).join("\n");
  assert.match(prerelease, /must not pin a version \(agentgather@9\.9\.9-rc\.1\)/, "a prerelease pin must fail");

  // Dropping the package prefix is the other way around a pin rule, so an npm
  // bullet in Shipped Today may not name a bare version either.
  const bare = npmReleaseDocProblems(fixture("- npm release: the registry currently serves 9.9.9")).join("\n");
  assert.match(bare, /must not name a release version \(9\.9\.9\)/, "a version named without the package prefix must fail");

  // ...and that rule is judged per BULLET, not per line, or a wrap splits the
  // claim from the word that identifies it as one — the same mistake the pin
  // rule was just fixed for, and the README's own npm bullet is wrapped. A
  // single-line fixture cannot tell a per-line rule from a per-bullet one, so
  // both wrap directions are driven here.
  const wrappedBare = npmReleaseDocProblems(
    fixture(`${lookup}\n- npm release: the registry currently serves\n  9.9.9`)
  ).join("\n");
  assert.match(wrappedBare, /must not name a release version \(9\.9\.9\)/, "a wrapped bare-version claim must fail");

  const versionFirst = npmReleaseDocProblems(fixture(`${lookup}\n- release 9.9.9 is what the\n  npm registry serves`)).join("\n");
  assert.match(versionFirst, /must not name a release version \(9\.9\.9\)/, "the version may wrap ahead of the npm mention");

  // A versioned registry URL states the same claim with no `agentgather@` and no
  // `npm` word — `\bnpm\b` does not match `npmjs.com`.
  const versionedUrl = npmReleaseDocProblems(
    fixture(`${lookup}\n- release page:\n  https://www.npmjs.com/package/agentgather/v/0.2.2`)
  ).join("\n");
  assert.match(versionedUrl, /must not name a release version \(0\.2\.2\)/, "a versioned registry URL must fail");

  // The bullet unit must not become the section unit: a version in an unrelated
  // bullet is not a release claim just because another bullet says `npm`.
  assert.deepEqual(
    npmReleaseDocProblems(fixture(`${lookup}\n- requires Node 20.10 or newer`)),
    [],
    "a version in a neighbouring, non-npm bullet must stay unrelated"
  );

  // ...and that rule must not fire on the shipped wording, which names no
  // version at all. Proving the two directions separately keeps the bare-version
  // rule from passing by rejecting everything.
  assert.deepEqual(npmReleaseDocProblems(fixture(lookup)), [], "the shipped wording must still pass");

  // The over-correction to stay clear of: `agentgather@latest` and
  // `agentgather@next` are dist-tag specifiers, not pins. They do not go stale —
  // they are the evergreen thing #329 wants a reader pointed at — so a pattern
  // broad enough to reject them would be rejecting the fix.
  for (const specifier of ["agentgather@latest", "agentgather@next"]) {
    assert.deepEqual(
      npmReleaseDocProblems(`${fixture(lookup)}\n## Install\n\nRun \`npx ${specifier}\`.\n`),
      [],
      `a dist-tag specifier must not be treated as a pin: ${specifier}`
    );
  }
});
