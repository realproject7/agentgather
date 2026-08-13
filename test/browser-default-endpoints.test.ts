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
import { findDefaultEndpointUses } from "./support/default-endpoint-scan.js";

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
  const host = "127.0.0.1";
  const dashboardPort = 8788;
  const roomPort = 8787;

  // The line that wrote 66 rows, in shape.
  assert.equal(
    DEFAULT_ENDPOINT_PATTERN.test(`await page.goto(\`\${base}/?dashboard=\${encodeURIComponent("http://${host}:${dashboardPort}")}\`);`),
    true,
    "the scan would not have caught the line that wrote 66 rows"
  );
  assert.equal(
    DEFAULT_ENDPOINT_PATTERN.test(`await page.fill("#joined-input", "http://${host}:${roomPort}/x");`),
    true,
    "the scan would not have caught a saved pointer at the default room port"
  );

  // Every spelling the PRODUCT treats as this host, one pinned case each (@re2).
  // `isLoopbackHost` (`src/browser/room.js:1519-1521`) accepts all four, so a
  // guard that matched only the dotted form would read as complete while leaving
  // three ways to write the same live address.
  for (const alias of ["127.0.0.1", "localhost", "[::1]", "::1"]) {
    for (const port of [roomPort, dashboardPort]) {
      assert.equal(
        DEFAULT_ENDPOINT_PATTERN.test(`const dashboard = "http://${alias}:${port}";`),
        true,
        `${alias}:${port} is a loopback default the product accepts and the scan missed`
      );
    }
  }
  // ...and a non-default port on those same aliases is not a hit, so the guard
  // bounds itself to the two product defaults rather than to loopback in general.
  for (const alias of ["127.0.0.1", "localhost", "[::1]"]) {
    assert.equal(DEFAULT_ENDPOINT_PATTERN.test(`const d = "http://${alias}:9";`), false, `${alias}:9 must not be a hit`);
  }
  // ...and the replacements it steers towards are not themselves hits.
  assert.equal(DEFAULT_ENDPOINT_PATTERN.test(`const dashboard = "http://${host}:9";`), false);
  assert.equal(DEFAULT_ENDPOINT_PATTERN.test("const dashboard = fixture.baseUrl;"), false);
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
  const host = "127.0.0.1";
  const port = 8788;
  const offending = `const dashboard = "http://${host}:${port}";\n`;

  await write(path.join("test", "browser-x.test.ts"), offending);
  await write(path.join("test", "e2e", "nested", "deep.test.ts"), offending);
  await write(path.join("test", "support", "a", "b", "helper.ts"), offending);
  // Not in the surface: a top-level `test/*.ts` that is not a browser test.
  await write(path.join("test", "cli-thing.test.ts"), offending);
  // A comment naming a default is allowed anywhere in the surface.
  await write(path.join("test", "support", "note.ts"), `// see http://${host}:${port} — never use it\n`);

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
