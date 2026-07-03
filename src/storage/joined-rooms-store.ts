import { readFile } from "node:fs/promises";
import path from "node:path";
import { ensureSecureDir, writeSecureFile } from "./secure-fs.js";

// Device-local record of a room this user has joined as a participant (#178).
// METADATA ONLY — a participant bearer token is NEVER persisted here (the token
// lives in the per-alias token store / per-session entry). This file never leaves
// the device; there is no central membership copy.
export interface JoinedRoom {
  roomId: string;
  title: string;
  alias: string;
  baseUrl: string;
  joinedAt: string;
  lastSeen: string;
}

interface JoinedRoomsStore {
  rooms: JoinedRoom[];
}

export function joinedRoomsPath(home: string): string {
  return path.join(home, "joined-rooms.json");
}

export async function readJoinedRooms(home: string): Promise<JoinedRoom[]> {
  try {
    const store = JSON.parse(await readFile(joinedRoomsPath(home), "utf8")) as JoinedRoomsStore;
    return Array.isArray(store.rooms) ? store.rooms : [];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

// Upsert one joined-room record (keyed by roomId + baseUrl). Only the metadata
// fields are written — the token is dropped even if present on the input, so this
// store can never accumulate a secret.
export async function recordJoinedRoom(home: string, entry: JoinedRoom): Promise<void> {
  await ensureSecureDir(home);
  const rooms = await readJoinedRooms(home);
  const index = rooms.findIndex((room) => room.roomId === entry.roomId && room.baseUrl === entry.baseUrl);
  const record: JoinedRoom = {
    roomId: entry.roomId,
    title: entry.title,
    alias: entry.alias,
    baseUrl: entry.baseUrl,
    joinedAt: index === -1 ? entry.joinedAt : (rooms[index]?.joinedAt ?? entry.joinedAt),
    lastSeen: entry.lastSeen
  };
  if (index === -1) rooms.push(record);
  else rooms[index] = record;
  await writeSecureFile(joinedRoomsPath(home), `${JSON.stringify({ rooms }, null, 2)}\n`);
}
