import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const SECURE_DIR_MODE = 0o700;
export const SECURE_FILE_MODE = 0o600;

// #261: the one ENOENT test for the whole codebase. It was written out in
// sixteen places — three of them here in src/storage — so every new caller had
// to choose between copying it again or adding another single-use helper. It
// lives with the filesystem access it describes.
//
// Deliberately ENOENT and nothing else: callers use it to distinguish "this path
// is simply absent", which is routine, from every other errno (EACCES, EISDIR,
// …) and from a SyntaxError, which carries no errno at all. Widening it would
// silently turn real faults into missing-file defaults at every call site.
export function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// Per-process counter that keeps concurrent temp-file names unique within this
// process; the pid keeps them unique across processes sharing the directory.
let tempCounter = 0;

export async function ensureSecureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: SECURE_DIR_MODE });
  await chmodIfPresent(dir, SECURE_DIR_MODE);
}

// Atomically REPLACE a secure file: write the payload to a sibling temp file,
// flush it, then rename it over the target. A crash or ENOSPC before the rename
// leaves the previous file intact — a concurrent reader observes either the whole
// old file or the whole new file, never a truncated/partial one. Use
// createSecureFile (never this) when a caller needs create-only no-clobber
// semantics: this always replaces an existing target.
export async function writeSecureFile(file: string, data: string): Promise<void> {
  await ensureSecureDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${tempCounter++}`;
  try {
    const handle = await open(temp, "wx", SECURE_FILE_MODE);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmodIfPresent(temp, SECURE_FILE_MODE);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

// Atomically CREATE a secure file, failing if it already exists. The exclusive
// open ("wx") is the atomic no-clobber guard: with concurrent creators exactly
// one wins and every loser gets the EEXIST already-exists failure. An existing
// target is never replaced — this preserves the create-only semantics that were
// previously expressed as `writeSecureFile(..., { flag: "wx" })`.
export async function createSecureFile(file: string, data: string): Promise<void> {
  await ensureSecureDir(path.dirname(file));
  const handle = await open(file, "wx", SECURE_FILE_MODE);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmodIfPresent(file, SECURE_FILE_MODE);
}

export async function appendSecureFile(file: string, data: string): Promise<void> {
  await ensureSecureDir(path.dirname(file));
  await writeFile(file, data, { flag: "a", mode: SECURE_FILE_MODE });
  await chmodIfPresent(file, SECURE_FILE_MODE);
}

async function chmodIfPresent(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}
