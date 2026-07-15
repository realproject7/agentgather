import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withWriterLock } from "../src/storage/index.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-lock-test-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

// Stale-lock contention: several writers race to reclaim one stale lock. Exactly
// one may be in the critical section at any moment (identity-safe reclaim never
// deletes a lock a peer just acquired), and every writer eventually runs.
test("concurrent writers reclaim one stale lock without ever overlapping", async () => {
  const root = await makeRoot();
  const lockPath = path.join(root, "write.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 999_999, createdAt: "2026-06-21T00:00:00.000Z" }));

  let active = 0;
  let maxActive = 0;
  let runs = 0;

  await Promise.all(
    Array.from({ length: 6 }, () =>
      withWriterLock(
        lockPath,
        async () => {
          active += 1;
          runs += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(5);
          active -= 1;
        },
        { retryDelayMs: 1, timeoutMs: 4_000, staleAfterMs: 30_000 }
      )
    )
  );

  assert.equal(runs, 6);
  assert.equal(maxActive, 1);
  await assert.rejects(readFile(lockPath, "utf8"), /ENOENT/);
});

// A live holder acquired by reclaiming a stale lock must not be reclaimed by a
// later waiter: the waiter waits its turn and never enters while the holder is in
// the critical section.
test("a waiter never reclaims a lock a peer holds after reclaiming a stale one", async () => {
  const root = await makeRoot();
  const lockPath = path.join(root, "write.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 999_999, createdAt: "2026-06-21T00:00:00.000Z" }));

  let holderInside = false;
  let waiterRan = false;
  let overlap = false;

  const holder = withWriterLock(
    lockPath,
    async () => {
      holderInside = true;
      await sleep(60);
      holderInside = false;
    },
    { retryDelayMs: 1, timeoutMs: 4_000, staleAfterMs: 30_000 }
  );

  await sleep(10);

  const waiter = withWriterLock(
    lockPath,
    async () => {
      waiterRan = true;
      if (holderInside) overlap = true;
    },
    { retryDelayMs: 1, timeoutMs: 4_000, staleAfterMs: 30_000 }
  );

  await Promise.all([holder, waiter]);

  assert.equal(waiterRan, true);
  assert.equal(overlap, false);
});
