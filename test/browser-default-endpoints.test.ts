// #305 — no browser/e2e test may address a product-default endpoint.
//
// The 66 polluted rows were not written by a test. A test pointed a room page at
// `127.0.0.1:8788`, and the product — a real dashboard listening there — did the
// writing. That is why this guards ADDRESSES rather than storage roots: no temp
// root on the test side can stop a page from posting to a live service.
//
// The guard is a scan, deliberately, because the alternative is thirteen files
// remembering to use a fixture URL and that is precisely the state that produced
// the rows.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { findDefaultEndpointUses, offendingSamples } from "./support/default-endpoint-scan.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("no browser or e2e test addresses a product-default endpoint (#305)", async () => {
  const hits = await findDefaultEndpointUses(REPO_ROOT);
  assert.deepEqual(
    hits.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`),
    [],
    "a test names a product default endpoint; use a fixture URL, or 127.0.0.1:9 when the address must be unreachable"
  );
});

// The guard must fail on the tree it was written for, or it proves nothing. This
// pins the detector itself against a fixture that contains the exact shape the
// real defect had, so "the scan returned nothing" cannot mean "the scan is blind".
test("the scan detects a default endpoint in code and ignores one in a comment (#305)", async () => {
  const { DEFAULT_ENDPOINT_PATTERN } = await import("./support/default-endpoint-scan.js");
  // The fixtures are COMPOSED rather than written literally, so this file stays
  // inside the scanned surface instead of being exempted from it. An exemption is
  // a place a real default endpoint could hide; composition keeps the guard
  // pointed at itself.
  // Finished strings from the definition site — this file names no port and no
  // host:port, so it stays inside the scanned surface it is guarding.
  const samples = offendingSamples();

  // Every spelling the PRODUCT treats as this host — `isLoopbackHost`
  // (`src/browser/room.js:1519-1521`) accepts all four — on both default ports.
  for (const line of samples.addressed) {
    assert.equal(DEFAULT_ENDPOINT_PATTERN.test(line), true, `the scan missed a product default: ${line}`);
  }
  // ...and the replacements it steers towards are not hits, so the guard is bound
  // to the two defaults rather than to loopback in general.
  for (const line of samples.clean) {
    assert.equal(DEFAULT_ENDPOINT_PATTERN.test(line), false, `the scan over-reported a safe address: ${line}`);
  }
  // The split form is invisible to the ADDRESS pattern by construction — that is
  // the whole point of the composition rule, asserted in its own test below.
  for (const line of samples.split) {
    assert.equal(DEFAULT_ENDPOINT_PATTERN.test(line), false);
  }
});

// @re1, PR #316 — the guard claims `test/e2e/**` and `test/support/**`. Both are
// flat today, so a one-level walk would pass every assertion above while silently
// missing the first nested file anyone adds. That is the same shape of gap this
// ticket exists to close, so recursion is proven against a real tree rather than
// asserted in a comment.
test("the scan walks e2e and support to any depth (#305)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-scan-"));
  const write = async (rel: string, body: string): Promise<void> => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  };
  const offending = `${offendingSamples().addressed[0]}\n`;

  await write(path.join("test", "browser-x.test.ts"), offending);
  await write(path.join("test", "e2e", "nested", "deep.test.ts"), offending);
  await write(path.join("test", "support", "a", "b", "helper.ts"), offending);
  // Not in the surface: a top-level `test/*.ts` that is not a browser test.
  await write(path.join("test", "cli-thing.test.ts"), offending);
  // A comment naming a default is allowed anywhere in the surface.
  await write(path.join("test", "support", "note.ts"), `// see ${offendingSamples().addressed[0]} — never use it\n`);

  const hits = await findDefaultEndpointUses(root);
  assert.deepEqual(
    hits.map((hit) => hit.file).sort(),
    [
      path.join("test", "browser-x.test.ts"),
      path.join("test", "e2e", "nested", "deep.test.ts"),
      path.join("test", "support", "a", "b", "helper.ts")
    ].sort(),
    "the scan missed a nested file, or reached outside its surface"
  );
});

// @re1, PR #316 — the bypass a one-line pattern cannot see.
//
// A test can declare the host and the port on SEPARATE lines, compose the URL at
// runtime, and reach the same live dashboard while every individual line passes a
// `host:port` pattern. This is not hypothetical: the detector test above was
// originally written that way to avoid self-matching, which is the proof the shape
// is writable by someone acting in good faith.
//
// So the rule is centralised — `default-endpoint-scan.ts` is the one file allowed
// to name a default port, and naming one anywhere else in the surface is a hit
// however it is split. The exemption is a single named file, and its being the
// ONLY one is asserted rather than assumed.
test("a split host/port composition is rejected, and the exemption is one file (#305)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-split-"));
  const write = async (rel: string, body: string): Promise<void> => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  };
  const samples = offendingSamples();

  // The bypass, exactly as @re1 described it: no line contains `host:port`.
  await write(
    path.join("test", "browser-split.test.ts"),
    samples.split.concat("await page.goto(`${base}/?dashboard=${encodeURIComponent(`http://${host}:${port}`)}`);").join("\n")
  );
  // The same shape one directory deeper.
  await write(path.join("test", "e2e", "deep", "split.test.ts"), `${samples.split.join("\n")}\n`);
  // A file that composes nothing and names nothing must stay clean.
  await write(path.join("test", "support", "clean.ts"), `const target = fixture.baseUrl;\nconst spare = 9;\n`);

  const hits = await findDefaultEndpointUses(root);
  assert.deepEqual(
    hits.map((hit) => hit.file).sort(),
    [path.join("test", "browser-split.test.ts"), path.join("test", "e2e", "deep", "split.test.ts")].sort(),
    "a split host/port composition slipped past the guard, or a clean file was flagged"
  );

  // The definition site is exempt; nothing else is. Proven by putting the SAME
  // declaration in both and asserting only the non-exempt one is reported.
  const root2 = await mkdtemp(path.join(os.tmpdir(), "agentgather-exempt-"));
  const decl = `${samples.split.join("\n")}\n`;
  await write2(root2, path.join("test", "support", "default-endpoint-scan.ts"), decl);
  await write2(root2, path.join("test", "support", "impostor-scan.ts"), decl);
  const hits2 = await findDefaultEndpointUses(root2);
  assert.deepEqual(
    hits2.map((hit) => hit.file),
    [path.join("test", "support", "impostor-scan.ts")],
    "the exemption is not limited to the single definition file"
  );
});

async function write2(root: string, rel: string, body: string): Promise<void> {
  await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
  await writeFile(path.join(root, rel), body, "utf8");
}

// @re1, PR #316 — the constant itself was a composition source.
//
// While `DEFAULT_PORTS` was exported, any scanned test could import it and build
// `http://localhost:${DEFAULT_PORTS[1]}`: no literal port, no `host:port` string,
// guard clean, live dashboard reached. Making it module-private is stronger than
// detecting that — a non-exported binding cannot be imported at all, so the
// COMPILER refuses the path instead of a scan reporting it afterwards. (Verified
// while making the change: the build failed with TS2459 `declares 'DEFAULT_PORTS'
// locally, but it is not exported` until this file stopped importing it.)
//
// This pins the property so a later re-export cannot quietly restore the bypass:
// no export of the scan module may carry a product default port as DATA. The
// matcher regexes necessarily contain the numbers — that is what they match — but
// a pattern is not a value another module can compose an address from.
test("the scan module exports no product default port as data (#305)", async () => {
  const module_ = (await import("./support/default-endpoint-scan.js")) as Record<string, unknown>;
  assert.equal("DEFAULT_PORTS" in module_, false, "the ports are exported again — importable as a composition source");

  const carriesPort = (value: unknown): boolean => {
    if (typeof value === "number") return offendingSamples().addressed.some((line) => line.includes(String(value)));
    if (Array.isArray(value)) return value.some(carriesPort);
    return false;
  };
  for (const [name, value] of Object.entries(module_)) {
    assert.equal(carriesPort(value), false, `export ${name} carries a product default port as data`);
  }
});
