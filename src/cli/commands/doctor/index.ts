import { stat } from "node:fs/promises";
import { flagBoolean, parseArgs } from "../../args.js";
import type { CliContext } from "../../context.js";
import { currentPath, readCurrent, tokensPath } from "../../state.js";
import { readRoomState, roomPaths } from "../../../storage/index.js";

interface Check {
  name: string;
  ok: boolean;
  message: string;
}

export async function runDoctorCommand(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const checks: Check[] = [];
  const current = await readCurrentSafe(context.home);
  checks.push({
    name: "current-room",
    ok: current !== null,
    message: current === null ? "no current room; run telegent room join or room start" : `room=${current.roomId} alias=${current.alias}`
  });
  if (current !== null) {
    const paths = roomPaths(context.home, current.roomId);
    checks.push(await fileCheck("room-state", paths.state));
    checks.push(await fileCheck("messages-log", paths.messages));
    checks.push(await fileCheck("participants", paths.participants));
    checks.push(await fileCheck("token-store", tokensPath(context.home, current.roomId)));
    checks.push(await lockCheck(paths.lock));
    checks.push(await roomStateCheck(paths));
    checks.push(await serverCheck(current.baseUrl, current.token));
  }

  const ok = checks.every((check) => check.ok);
  if (flagBoolean(args, "json")) {
    context.stdout.write(`${JSON.stringify({ ok, checks })}\n`);
  } else {
    for (const check of checks) {
      context.stdout.write(`${check.ok ? "ok" : "fail"} ${check.name}: ${check.message}\n`);
    }
  }
  return ok ? 0 : 1;
}

async function readCurrentSafe(home: string): Promise<Awaited<ReturnType<typeof readCurrent>> | null> {
  try {
    return await readCurrent(home);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function fileCheck(name: string, file: string): Promise<Check> {
  try {
    await stat(file);
    return { name, ok: true, message: "present" };
  } catch (error) {
    return { name, ok: false, message: isNotFound(error) ? "missing" : errorMessage(error) };
  }
}

async function lockCheck(lockPath: string): Promise<Check> {
  try {
    await stat(lockPath);
    return { name: "writer-lock", ok: false, message: "lock file exists; another writer may be active or stale" };
  } catch (error) {
    return { name: "writer-lock", ok: isNotFound(error), message: isNotFound(error) ? "clear" : errorMessage(error) };
  }
}

async function roomStateCheck(paths: ReturnType<typeof roomPaths>): Promise<Check> {
  try {
    const state = await readRoomState(paths);
    return { name: "room-status", ok: true, message: state.status };
  } catch (error) {
    return { name: "room-status", ok: false, message: errorMessage(error) };
  }
}

async function serverCheck(baseUrl: string, token: string): Promise<Check> {
  try {
    const response = await fetch(new URL("/status", baseUrl), {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) {
      return { name: "room-server", ok: false, message: `HTTP ${response.status}` };
    }
    return { name: "room-server", ok: true, message: "reachable" };
  } catch {
    return { name: "room-server", ok: false, message: "not reachable at current baseUrl" };
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

