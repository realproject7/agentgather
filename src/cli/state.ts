import { readFile } from "node:fs/promises";
import path from "node:path";
import { ensureSecureDir, withWriterLock, writeSecureFile } from "../storage/index.js";

export interface CurrentRoom {
  roomId: string;
  alias: string;
  token: string;
  baseUrl: string;
}

export interface RoomTokenStore {
  tokens: Record<string, string>;
}

// Device-local joined-room history (#178) lives in the storage layer so both the
// CLI (write on `room join`) and the platform shell (read for "Rooms I'm in")
// share one token-free implementation.
export { joinedRoomsPath, readJoinedRooms, recordJoinedRoom, type JoinedRoom } from "../storage/index.js";

export function currentPath(home: string): string {
  return path.join(home, "current-room.json");
}

export function tokensPath(home: string, roomId: string): string {
  return path.join(home, "rooms", roomId, "tokens.json");
}

export function tokensLockPath(home: string, roomId: string): string {
  return path.join(home, "rooms", roomId, "tokens.lock");
}

export async function writeCurrent(home: string, current: CurrentRoom): Promise<void> {
  await ensureSecureDir(home);
  await writeSecureFile(currentPath(home), `${JSON.stringify(current, null, 2)}\n`);
}

export async function readCurrent(home: string): Promise<CurrentRoom> {
  return JSON.parse(await readFile(currentPath(home), "utf8")) as CurrentRoom;
}

export async function writeToken(home: string, roomId: string, alias: string, token: string): Promise<void> {
  const file = tokensPath(home, roomId);
  await ensureSecureDir(path.dirname(file));
  // Serialize the whole read-modify-write so concurrent `room join`s for two
  // aliases in the same room cannot both read the old store and clobber each
  // other's entry. The lock record holds only pid/createdAt — never a token.
  await withWriterLock(tokensLockPath(home, roomId), async () => {
    const store = await readTokenStore(home, roomId);
    store.tokens[alias] = token;
    await writeSecureFile(file, `${JSON.stringify(store, null, 2)}\n`);
  });
}

export async function readToken(home: string, roomId: string, alias: string): Promise<string> {
  const token = (await readTokenStore(home, roomId)).tokens[alias];
  if (token === undefined) throw new Error(`no token stored for ${alias}`);
  return token;
}

async function readTokenStore(home: string, roomId: string): Promise<RoomTokenStore> {
  try {
    return JSON.parse(await readFile(tokensPath(home, roomId), "utf8")) as RoomTokenStore;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { tokens: {} };
    }
    throw error;
  }
}
