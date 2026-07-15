import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSecureFile, writeSecureFile } from "../src/storage/index.js";

async function makeDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-securefs-test-"));
}

// Atomic replacement (temp-file + rename): a concurrent reader must observe either
// the whole previous file or the whole next file — never a truncated/partial one.
// This is the observable form of "a failure before rename leaves the previous
// valid JSON readable": the target is only ever changed by an atomic rename.
test("writeSecureFile replacement is atomic — concurrent reads never see a partial file", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "state.json");
  await writeSecureFile(file, JSON.stringify({ n: 0 }));

  const padding = "x".repeat(20_000);
  const writers = Array.from({ length: 40 }, (_, i) =>
    writeSecureFile(file, `${JSON.stringify({ n: i + 1, padding })}\n`)
  );
  const readers = Array.from({ length: 200 }, () =>
    readFile(file, "utf8").then((raw) => JSON.parse(raw) as { n: number })
  );

  const [, ...reads] = await Promise.all([Promise.all(writers), ...readers]);
  for (const value of reads) {
    // A truncated read would throw in JSON.parse above; a complete read always
    // carries a numeric n from one of the whole values written.
    assert.equal(typeof value.n, "number");
  }

  // No temp scratch files are left behind once every replacement resolves.
  const leftover = (await readdir(dir)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftover, []);
  assert.equal(typeof (JSON.parse(await readFile(file, "utf8")) as { n: number }).n, "number");
});

test("writeSecureFile writes 0600 mode and a trailing payload", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "state.json");
  await writeSecureFile(file, "hello\n");
  assert.equal(await readFile(file, "utf8"), "hello\n");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("createSecureFile creates a new file with 0600 mode", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "brief.md");
  await createSecureFile(file, "first");
  assert.equal(await readFile(file, "utf8"), "first");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("createSecureFile refuses to clobber an existing target and preserves its contents", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "brief.md");
  await createSecureFile(file, "first");
  await assert.rejects(createSecureFile(file, "second"), /EEXIST/);
  assert.equal(await readFile(file, "utf8"), "first");
});

// Replacement and create are distinct operations: replacement overwrites, create
// never does. This is the guard the ticket amendment requires — a create-only
// caller must not be silently turned into an overwrite.
test("writeSecureFile replaces where createSecureFile refuses", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "state.json");
  await writeSecureFile(file, "v1");
  await writeSecureFile(file, "v2");
  assert.equal(await readFile(file, "utf8"), "v2");
  await assert.rejects(createSecureFile(file, "v3"), /EEXIST/);
  assert.equal(await readFile(file, "utf8"), "v2");
});

test("concurrent createSecureFile — exactly one wins, every loser gets the already-exists failure", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "brief.md");

  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      createSecureFile(file, `writer-${i}`)
        .then(() => ({ ok: true as const, index: i }))
        .catch((error: NodeJS.ErrnoException) => ({ ok: false as const, code: error.code }))
    )
  );

  const winners = attempts.filter((r): r is { ok: true; index: number } => r.ok);
  assert.equal(winners.length, 1);
  for (const loser of attempts.filter((r) => !r.ok)) {
    assert.equal((loser as { code?: string }).code, "EEXIST");
  }
  assert.equal(await readFile(file, "utf8"), `writer-${winners[0]?.index}`);
});
