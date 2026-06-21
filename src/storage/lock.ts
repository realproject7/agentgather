import { open, readFile, rm } from "node:fs/promises";

export interface LockOptions {
  retryDelayMs?: number;
  timeoutMs?: number;
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
  const startedAt = Date.now();
  const record: LockRecord = { pid: process.pid, createdAt: new Date().toISOString() };

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify(record));
      await handle.close();
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`timed out waiting for writer lock: ${lockPath}`);
      }
      if (await removeStaleLock(lockPath)) continue;
      await sleep(retryDelayMs);
    }
  }
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof parsed.pid !== "number" || !isProcessAlive(parsed.pid)) {
      await rm(lockPath, { force: true });
      return true;
    }
  } catch (error) {
    if (isNotFoundError(error)) return false;
    await rm(lockPath, { force: true });
    return true;
  }
  return false;
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
