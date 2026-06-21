import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withWriterLock } from "../src/storage/index.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "telegent-lock-test-"));
}

test("withWriterLock removes a stale lock whose process is no longer alive", async () => {
  const root = await makeRoot();
  const lockPath = path.join(root, "write.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 999_999, createdAt: "2026-06-21T00:00:00.000Z" }));

  const value = await withWriterLock(lockPath, async () => "acquired", {
    retryDelayMs: 1,
    timeoutMs: 250
  });

  assert.equal(value, "acquired");
  await assert.rejects(readFile(lockPath, "utf8"), /ENOENT/);
});

test("withWriterLock waits instead of deleting a fresh malformed lock", async () => {
  const root = await makeRoot();
  const lockPath = path.join(root, "write.lock");
  await writeFile(lockPath, "");

  await assert.rejects(
    withWriterLock(lockPath, async () => "not acquired", {
      retryDelayMs: 1,
      timeoutMs: 20,
      staleAfterMs: 30_000
    }),
    /timed out/
  );
  assert.equal(await readFile(lockPath, "utf8"), "");
});
