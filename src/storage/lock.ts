import { chmod, open, readFile, rm, stat } from "node:fs/promises";
import { SECURE_FILE_MODE } from "./secure-fs.js";

export interface LockOptions {
  retryDelayMs?: number;
  timeoutMs?: number;
  staleAfterMs?: number;
}

interface LockRecord {
  pid: number;
  createdAt: string;
}

export async function withWriterLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const release = await acquireWriterLock(lockPath, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function acquireWriterLock(
  lockPath: string,
  options: LockOptions
): Promise<() => Promise<void>> {
  const retryDelayMs = options.retryDelayMs ?? 10;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  const startedAt = Date.now();
  const record: LockRecord = { pid: process.pid, createdAt: new Date().toISOString() };

  while (true) {
    try {
      const handle = await open(lockPath, "wx", SECURE_FILE_MODE);
      await handle.writeFile(JSON.stringify(record));
      await handle.close();
      await chmod(lockPath, SECURE_FILE_MODE);
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`timed out waiting for writer lock: ${lockPath}`);
      }
      if (await removeStaleLock(lockPath, staleAfterMs)) continue;
      await sleep(retryDelayMs);
    }
  }
}

async function removeStaleLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return false;
    // A transient read failure is not our lock to reclaim — back off and retry
    // rather than deleting a file we could not identify.
    return false;
  }

  let parsed: Partial<LockRecord> | undefined;
  try {
    parsed = JSON.parse(raw) as Partial<LockRecord>;
  } catch {
    parsed = undefined;
  }

  if (parsed && typeof parsed.pid === "number") {
    // A live holder is never reclaimed. A dead holder is reclaimed only under the
    // serialized, identity-checked reclaim path below.
    if (isProcessAlive(parsed.pid)) return false;
    return reclaimStaleRecord(lockPath, raw, staleAfterMs);
  }

  // A malformed record is reclaimed only once it is older than the stale window
  // (so we never race a lock mid-write).
  if (!(await isOlderThan(lockPath, staleAfterMs))) return false;
  return reclaimStaleRecord(lockPath, raw, staleAfterMs);
}

// Serialize reclamation with an exclusive reclaim lock, then re-read the primary
// lock under it and remove it ONLY if it is still byte-for-byte `expectedRaw`
// (the record we judged stale). This is TOCTOU-free: while the primary still holds
// that record it cannot be acquired (acquisition needs the file absent, and only a
// reclaimer — serialized here — removes it), so a live successor lock is never
// removed and the check-then-remove cannot race a fresh acquire.
async function reclaimStaleRecord(
  lockPath: string,
  expectedRaw: string,
  staleAfterMs: number
): Promise<boolean> {
  const reclaimPath = `${lockPath}.reclaim`;
  try {
    const handle = await open(reclaimPath, "wx", SECURE_FILE_MODE);
    // Stamp the reclaim lock with our identity so a would-be cleaner can tell a
    // live-but-slow reclaimer from a crashed one by liveness, not by age alone.
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
    // Another reclaimer holds the reclaim lock; reclaim it only if its owner is
    // dead (a crash mid-reclaim), then back off and retry acquire.
    await clearAbandonedReclaimLock(reclaimPath, staleAfterMs);
    return false;
  }

  try {
    let current: string;
    try {
      current = await readFile(lockPath, "utf8");
    } catch (error) {
      // Already removed — treat as progress so the caller retries the acquire.
      return isNotFoundError(error);
    }
    // A byte-identical record is the same dead holder we judged stale; anything
    // else is a live successor that must not be touched.
    if (current !== expectedRaw) return false;
    await rm(lockPath, { force: true });
    return true;
  } finally {
    await rm(reclaimPath, { force: true });
  }
}

// Recover a reclaim lock only when its owner is provably gone. A live owner keeps
// exclusivity regardless of age, so a reclaimer that is merely slow (delayed past
// staleAfterMs) never loses the reclaim lock to a peer. Only a dead owner — or an
// unparseable/legacy lock older than the stale window — is cleared.
async function clearAbandonedReclaimLock(reclaimPath: string, staleAfterMs: number): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(reclaimPath, "utf8");
  } catch {
    return;
  }
  let parsed: Partial<LockRecord> | undefined;
  try {
    parsed = JSON.parse(raw) as Partial<LockRecord>;
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed.pid === "number") {
    if (isProcessAlive(parsed.pid)) return;
    await rm(reclaimPath, { force: true });
    return;
  }
  if (await isOlderThan(reclaimPath, staleAfterMs)) {
    await rm(reclaimPath, { force: true });
  }
}

async function isOlderThan(lockPath: string, ageMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs >= ageMs;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isNoSuchProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
