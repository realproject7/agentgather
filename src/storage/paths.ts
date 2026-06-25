import path from "node:path";
import { assertSafeSlug } from "../protocol/validation.js";

export interface RoomPaths {
  root: string;
  rooms: string;
  room: string;
  state: string;
  participants: string;
  brief: string;
  messages: string;
  cursors: string;
  boardroom: string;
  channelCursors: string;
  lock: string;
}

export function roomPaths(root: string, roomId: string): RoomPaths {
  assertSafeSlug(roomId, "room id");
  const rooms = path.join(root, "rooms");
  const room = path.join(rooms, roomId);
  return {
    root,
    rooms,
    room,
    state: path.join(room, "room.json"),
    participants: path.join(room, "participants.json"),
    brief: path.join(room, "brief.md"),
    messages: path.join(room, "messages.jsonl"),
    cursors: path.join(room, "cursors"),
    boardroom: path.join(room, "boardroom.json"),
    channelCursors: path.join(room, "channel-cursors"),
    lock: path.join(room, "write.lock")
  };
}
