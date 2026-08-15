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
const PINNED_NPM_VERSION = /agentgather@\d+\.\d+\.\d+/;
const PUBLICATION_CLAIM = /\b(?:latest|dist-tag|published)\b/i;

// Two rules, because passing the first one alone is the likely half-done edit:
// adding the lookup command ABOVE the stale sentence leaves the stale sentence.
// Returned as a list rather than asserted inline so the guard can be driven
// against fixtures that MUST fail — an all-negative suite cannot tell "the rule
// works" from "the rule never fires".
function npmReleaseDocProblems(readme: string): string[] {
  const problems: string[] = [];
  const shipped = readmeSection(readme, "Shipped Today");

  // Whitespace-insensitive: the command may be rewrapped by an editor without
  // changing what it tells the reader to run.
  if (!shipped.replace(/\s+/g, " ").includes(NPM_VERSION_LOOKUP)) {
    problems.push(`Shipped Today must name \`${NPM_VERSION_LOOKUP}\` as the way to read the published version`);
  }

  const pinned = shipped.match(PINNED_NPM_VERSION);
  if (pinned !== null) {
    problems.push(`Shipped Today must not pin a version (${pinned[0]}); the registry owns that answer`);
  }

  // The claim can return anywhere in the file, not only in the section this
  // ticket found it in.
  for (const line of readme.split("\n")) {
    if (PINNED_NPM_VERSION.test(line) && PUBLICATION_CLAIM.test(line)) {
      problems.push(`a static published-version claim returned: ${line.trim()}`);
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
  assert.match(elsewhere, /a static published-version claim returned/, "a claim outside Shipped Today must still fail");

  const noLookup = npmReleaseDocProblems(fixture("- npm release: published on npm as `agentgather`")).join("\n");
  assert.match(noLookup, /must name `npm view agentgather version`/, "removing the lookup must fail");
});
