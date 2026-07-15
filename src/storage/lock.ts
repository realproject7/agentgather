import { chmod, link, open, readFile, rename, rm, stat } from "node:fs/promises";
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

// Per-process counter that keeps concurrent reclaim scratch names unique.
let reclaimCounter = 0;

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
    // A live holder is never reclaimed. A dead holder is reclaimed only if the
    // on-disk record is still byte-for-byte the one we just judged dead.
    if (isProcessAlive(parsed.pid)) return false;
    return reclaimIfUnchanged(lockPath, raw);
  }

  // A malformed record is reclaimed only once it is older than the stale window
  // (so we never race a lock mid-write) AND still unchanged when we move it aside.
  if (!(await isOlderThan(lockPath, staleAfterMs))) return false;
  return reclaimIfUnchanged(lockPath, raw);
}

// Reclaim the lock at `lockPath` only if its contents are still exactly
// `expectedRaw` — the record we inspected and judged reclaimable. We atomically
// move the file aside (rename wins for exactly one contender) and re-read the
// moved copy: if it matches, the stale record is safely discarded; if it changed
// (a live successor acquired the lock between our read and our move) we restore it
// without clobbering, so reclaim can never delete a newly acquired lock.
async function reclaimIfUnchanged(lockPath: string, expectedRaw: string): Promise<boolean> {
  const moved = `${lockPath}.reclaim-${process.pid}-${reclaimCounter++}`;
  try {
    await rename(lockPath, moved);
  } catch (error) {
    // Someone else already reclaimed or replaced-and-removed the lock; treat it
    // as progress and let the caller retry the acquire.
    if (isNotFoundError(error)) return true;
    throw error;
  }

  let movedRaw: string | undefined;
  try {
    movedRaw = await readFile(moved, "utf8");
  } catch {
    movedRaw = undefined;
  }

  if (movedRaw === expectedRaw) {
    await rm(moved, { force: true });
    return true;
  }

  await restoreReclaimedLock(moved, lockPath);
  return false;
}

// Put a moved lock file back at `lockPath` without ever overwriting a lock that
// reappeared meanwhile. `link` fails with EEXIST if the target exists, so a lock
// created in the gap is preserved and our moved copy is dropped instead.
async function restoreReclaimedLock(moved: string, lockPath: string): Promise<void> {
  try {
    await link(moved, lockPath);
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
  }
  await rm(moved, { force: true });
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
