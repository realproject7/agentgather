import { readdir } from "node:fs/promises";
import path from "node:path";
import { isNotFoundError, readJoinedRooms, roomPaths } from "../../../storage/index.js";
import { readCurrent, type CurrentRoom } from "../../state.js";

// #310: a host-only command run from a home that only joined the room used to
// fail with a raw ENOENT on a host-only file (`participants.json`), because
// `readCurrent()` succeeds in a participant home — the device joined the room, so
// it has `current-room.json`, `tokens.json` and `cursors/` for it, but none of the
// host-owned files. A missing-file error tells the reader to recreate a file; the
// true condition is that this home is not the host of this room, which tells them
// to run the command somewhere else. Reporting the wrong KIND of failure sends the
// reader down a path that cannot work (#242's principle).
//
// So every host-only room subcommand classifies the home BEFORE the first
// host-only read, and each state gets its own message.
type RoomHomeClassification =
  // This home owns the room store: the host-only command proceeds unchanged.
  | { state: "host"; current: CurrentRoom }
  // This home holds a device-local participant copy of the room it names.
  | { state: "participant"; current: CurrentRoom }
  // A current room is selected, but this home has no copy of it at all.
  | { state: "unknown"; current: CurrentRoom }
  // No room is selected in this home (`current-room.json` is absent).
  | { state: "no-current-room"; current: null };

// `room.json` and `participants.json` are the host-owned markers: the first is
// written only by `createRoom`, the second only by the host participant writers,
// and no participant-side path can create either. `room join` writes
// `current-room.json` and `rooms/<id>/tokens.json`; `read`/`channel-read` add
// cursors; a participant `send` to an unreachable host fails on the missing room
// state rather than writing one. So either marker in the room directory means
// this home is the host's, and a room directory without one is a joined copy.
//
// Either, not both, on purpose. A host home whose `room.json` was removed by hand
// is a damaged host store, not a participant copy — claiming the latter would be
// the very substitution this ticket exists to stop — so it keeps its existing
// behavior instead.
async function classifyRoomHome(home: string): Promise<RoomHomeClassification> {
  let current: CurrentRoom;
  try {
    current = await readCurrent(home);
  } catch (error) {
    if (isNotFoundError(error)) return { state: "no-current-room", current: null };
    throw error;
  }
  const paths = roomPaths(home, current.roomId);
  let roomDir: string[];
  try {
    roomDir = await readdir(paths.room);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    // Not even a device-local directory for this room. A joined-rooms row is the
    // one remaining trace a copy can leave (the dashboard's invite import records
    // the row), and it still means "joined, not hosted".
    const joined = await readJoinedRooms(home);
    return joined.some((entry) => entry.roomId === current.roomId)
      ? { state: "participant", current }
      : { state: "unknown", current };
  }
  const hostOwned = [paths.state, paths.participants].map((file) => path.basename(file));
  if (hostOwned.some((file) => roomDir.includes(file))) return { state: "host", current };
  return { state: "participant", current };
}

// Resolve the current room for a host-only command, or throw the message that
// names the actual condition. `command` is the user-facing invocation
// (e.g. "room invite"), so the message says which command needs the host home.
//
// Every message here is deliberately path-free and token-free: the room id is the
// only identifier that appears — never `AGENTGATHER_HOME`'s value, an internal
// file path, or anything out of `tokens.json`.
export async function requireHostRoom(home: string, command: string): Promise<CurrentRoom> {
  const classification = await classifyRoomHome(home);
  if (classification.state === "host") return classification.current;
  const relocate = "Run it on the host device, or point AGENTGATHER_HOME at the home that hosts this room.";
  if (classification.state === "no-current-room") {
    throw new Error(
      [
        `\`agentgather ${command}\` is a host-only command and this home has no current room.`,
        "Run `agentgather room start <room>` to host a room in this home, or `agentgather room join` to join one."
      ].join("\n")
    );
  }
  if (classification.state === "participant") {
    throw new Error(
      [
        `\`agentgather ${command}\` is a host-only command and this home is not the host of room "${classification.current.roomId}".`,
        "This home holds a participant copy of that room: this device joined it, so it has none of the room's host files.",
        relocate
      ].join("\n")
    );
  }
  throw new Error(
    [
      `\`agentgather ${command}\` is a host-only command and this home does not know room "${classification.current.roomId}".`,
      "This home has neither a hosted room store nor a joined participant copy of it.",
      relocate
    ].join("\n")
  );
}
