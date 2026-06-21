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
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof parsed.pid !== "number") {
      return removeMalformedLockIfOld(lockPath, staleAfterMs);
    }
    if (!isProcessAlive(parsed.pid)) {
      await rm(lockPath, { force: true });
      return true;
    }
  } catch (error) {
    if (isNotFoundError(error)) return false;
    return removeMalformedLockIfOld(lockPath, staleAfterMs);
  }
  return false;
}

async function removeMalformedLockIfOld(lockPath: string, staleAfterMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < staleAfterMs) return false;
  } catch (error) {
    return isNotFoundError(error);
  }
  await rm(lockPath, { force: true });
  return true;
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
