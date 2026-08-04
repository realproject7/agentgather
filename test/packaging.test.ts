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

test("the README reports the published npm release and keeps the production operator gates unshipped (#243)", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

  const shipped = readmeSection(readme, "Shipped Today");
  assert.match(shipped, /npm/i, "Shipped Today must record the npm release");
  assert.match(shipped, /agentgather@0\.2\.2/, "Shipped Today must name the published version");

  const roadmap = readmeSection(readme, "Roadmap, Not Shipped Yet");
  assert.match(
    roadmap,
    /production `agentgather\.dev` operator gates/,
    "the production operator gates must remain listed as not shipped"
  );
  assert.doesNotMatch(roadmap, /npm publish/i, "the roadmap must no longer claim npm publish is unshipped");
});
