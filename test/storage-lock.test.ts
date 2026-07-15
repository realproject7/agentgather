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
// one may be in the critical section at any moment (serialized, identity-checked
// reclaim never deletes a lock a peer just acquired), and every writer runs.
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

// Independently scheduled reclaimers race the SAME stale lock. The regression
// this guards: a delayed reclaimer must never move aside / remove the lock a peer
// just acquired (no double hold, no resurrected or wedged lock). While a holder is
// in the critical section, its on-disk lock stays present and unchanged — a peer
// reclaimer that disturbed it surfaces here as an ENOENT read or a changed record.
// The race is scheduling-dependent, so we run many rounds of contention: the prior
// move-aside implementation fails a double-digit fraction of rounds (verified), so
// across this many rounds it is caught with overwhelming probability; the
// serialized identity-checked reclaim passes every round.
test("racing reclaimers never double-hold, move a fresh lock aside, or wedge the lock", async () => {
  const contenders = 4;
  const rounds = 60;

  for (let round = 0; round < rounds; round += 1) {
    const root = await makeRoot();
    const lockPath = path.join(root, "write.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 999_999, createdAt: "2026-06-21T00:00:00.000Z" }));

    let active = 0;
    let maxActive = 0;
    let runs = 0;

    const run = (): Promise<void> =>
      withWriterLock(
        lockPath,
        async () => {
          active += 1;
          runs += 1;
          maxActive = Math.max(maxActive, active);
          // Our lock must stay present and be our own record for the whole
          // critical section — a peer reclaimer must not move it aside or remove it.
          const first = await readFile(lockPath, "utf8");
          for (let i = 0; i < 4; i += 1) {
            await sleep(2);
            assert.equal(await readFile(lockPath, "utf8"), first, "lock disturbed while held");
          }
          active -= 1;
        },
        { retryDelayMs: 1, timeoutMs: 4_000, staleAfterMs: 30_000 }
      );

    await Promise.all(Array.from({ length: contenders }, () => run()));

    assert.equal(runs, contenders, `round ${round}: not every writer ran`);
    assert.equal(maxActive, 1, `round ${round}: double hold`);
    await assert.rejects(readFile(lockPath, "utf8"), /ENOENT/); // released cleanly
    await assert.rejects(readFile(`${lockPath}.reclaim`, "utf8"), /ENOENT/); // no wedged reclaim lock
  }
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
