import {
  appendServerMessage,
  closeRoom,
  createRoom,
  readBrief,
  readParticipants,
  readRoomState,
  roomPaths,
  updateBrief,
  upsertParticipant,
  writeParticipants
} from "../../../storage/index.js";
import type { Participant, ParticipantKind, RoomBrief } from "../../../protocol/index.js";
import { normalizeBaseUrl, roomUrl } from "../../../protocol/index.js";
import { createToken } from "../../../auth/index.js";
import { createRoomHttpServer, participantTokenHash, renderAttendCard } from "../../../server/index.js";
import { parseArgs, flagBoolean, flagString } from "../../args.js";
import type { CliContext } from "../../context.js";
import { readCurrent, readToken, writeCurrent, writeToken } from "../../state.js";

export async function runRoomCommand(argv: string[], context: CliContext): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "start") return roomStart(rest, context);
  if (subcommand === "brief") return roomBrief(rest, context);
  if (subcommand === "serve") return roomServe(rest, context);
  if (subcommand === "invite") return roomInvite(rest, context);
  if (subcommand === "invite-card") return roomInviteCard(rest, context);
  if (subcommand === "join") return roomJoin(rest, context);
  if (subcommand === "current") return roomCurrent(rest, context);
  if (subcommand === "leave") return roomLeave(rest, context);
  if (subcommand === "close") return roomClose(rest, context);
  if (subcommand === "dashboard") return roomDashboard(rest, context);
  context.stderr.write(`Unknown room command: ${subcommand ?? ""}\n`);
  return 1;
}

async function roomStart(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const roomId = args.positional[0];
  if (roomId === undefined) throw new Error("room id is required");
  const alias = flagString(args, "alias") ?? "host";
  const baseUrl = normalizeBaseUrl(flagString(args, "url") ?? "http://127.0.0.1:8787");
  const token = createToken();
  const briefBody = flagString(args, "brief") ?? "";
  const expiresAt = flagString(args, "expires-at");
  await createRoom({
    root: context.home,
    roomId,
    hostAlias: alias,
    briefBody,
    ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt) })
  });
  await writeParticipants(context.home, roomId, [participant(alias, "human", true, token)]);
  await writeToken(context.home, roomId, alias, token);
  await writeCurrent(context.home, { roomId, alias, token, baseUrl });
  return emit(context, flagBoolean(args, "json"), { ok: true, room: roomId, alias, token, baseUrl });
}

async function roomBrief(argv: string[], context: CliContext): Promise<number> {
  const [action, ...rest] = argv;
  const current = await readCurrent(context.home);
  const args = parseArgs(rest);
  if (action === "view") {
    const brief = await readBrief(context.home, current.roomId);
    return emit(context, flagBoolean(args, "json"), { ok: true, brief }, brief.body);
  }
  if (action === "set") {
    const body = flagString(args, "body") ?? args.positional.join(" ");
    if (body.length === 0) throw new Error("brief body is required");
    const brief =
      (await postBriefToServer(current.baseUrl, current.token, body)) ??
      (await updateBriefDirect(context, current.roomId, current.alias, body));
    return emit(context, flagBoolean(args, "json"), { ok: true, brief });
  }
  throw new Error("room brief requires view or set");
}

async function postBriefToServer(baseUrl: string, token: string, body: string): Promise<RoomBrief | null> {
  try {
    const response = await fetch(new URL("/brief", baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ body })
    });
    const payload = await readResponseJson<{ brief?: RoomBrief; message?: string }>(response);
    if (response.status === 404) return null;
    if (!response.ok || payload.brief === undefined) {
      throw new Error(payload.message ?? `brief update failed with HTTP ${response.status}`);
    }
    return payload.brief;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

async function readResponseJson<T>(response: Response): Promise<Partial<T>> {
  try {
    return JSON.parse(await response.text()) as Partial<T>;
  } catch {
    return {};
  }
}

async function updateBriefDirect(
  context: CliContext,
  roomId: string,
  alias: string,
  body: string
): Promise<RoomBrief> {
  const brief = await updateBrief({
    root: context.home,
    roomId,
    body,
    updatedBy: alias
  });
  await appendServerMessage({
    root: context.home,
    roomId,
    from: "system",
    text: `Room brief updated to v${brief.brief_version}`
  });
  return brief;
}

async function roomInvite(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const alias = args.positional[0];
  if (alias === undefined) throw new Error("participant alias is required");
  const current = await readCurrent(context.home);
  const kind = parseKind(flagString(args, "kind") ?? "agent");
  const token = createToken();
  await upsertParticipant(context.home, current.roomId, participant(alias, kind, false, token));
  await writeToken(context.home, current.roomId, alias, token);
  const cardCommand = `curl -s "${roomUrl(current.baseUrl, `/card?participant=${alias}&token=${token}`)}"`;
  return emit(context, flagBoolean(args, "json"), { ok: true, room: current.roomId, alias, token, card_command: cardCommand }, `Invite ${alias}:\n${cardCommand}\n`);
}

async function roomInviteCard(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const alias = args.positional[0];
  if (alias === undefined) throw new Error("participant alias is required");
  const current = await readCurrent(context.home);
  const token = await readToken(context.home, current.roomId, alias);
  const brief = await readBrief(context.home, current.roomId);
  const card = renderAttendCard(current.baseUrl, alias, token, brief);
  return emit(context, flagBoolean(args, "json"), { ok: true, room: current.roomId, alias, card }, `${card}\n`);
}

async function roomJoin(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const roomId = args.positional[0] ?? flagString(args, "room");
  const alias = flagString(args, "alias");
  const token = flagString(args, "token");
  const baseUrl = normalizeBaseUrl(flagString(args, "url") ?? "http://127.0.0.1:8787");
  if (roomId === undefined || alias === undefined || token === undefined) {
    throw new Error("room join requires room, --alias, and --token");
  }
  await writeCurrent(context.home, { roomId, alias, token, baseUrl });
  await writeToken(context.home, roomId, alias, token);
  return emit(context, flagBoolean(args, "json"), { ok: true, room: roomId, alias, baseUrl });
}

async function roomCurrent(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const current = await readCurrent(context.home);
  const state = await readRoomState(roomPaths(context.home, current.roomId));
  return emit(context, flagBoolean(args, "json"), { ok: true, current, room_status: state.status });
}

async function roomLeave(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const current = await readCurrent(context.home);
  const participants = await readParticipants(roomPaths(context.home, current.roomId));
  const existing = participants.find((item) => item.alias === current.alias);
  if (existing !== undefined) {
    await upsertParticipant(context.home, current.roomId, {
      ...existing,
      attention: "away",
      lastSeenAt: new Date().toISOString()
    });
  }
  await appendServerMessage({ root: context.home, roomId: current.roomId, from: "system", text: `${current.alias} left` });
  return emit(context, flagBoolean(args, "json"), { ok: true });
}

async function roomClose(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const current = await readCurrent(context.home);
  const state = await closeRoom(context.home, current.roomId);
  await appendServerMessage({ root: context.home, roomId: current.roomId, from: "system", text: "room closed" });
  return emit(context, flagBoolean(args, "json"), { ok: true, room_status: state.status });
}

async function roomDashboard(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const current = await readCurrent(context.home);
  return emit(context, flagBoolean(args, "json"), { ok: true, url: current.baseUrl }, `Dashboard: ${current.baseUrl}\n`);
}

async function roomServe(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const current = await readCurrent(context.home);
  const baseUrl = new URL(current.baseUrl);
  const portValue = flagString(args, "port") ?? (baseUrl.port || "8787");
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  baseUrl.port = String(port);
  const server = createRoomHttpServer({
    root: context.home,
    roomId: current.roomId,
    baseUrl: normalizeBaseUrl(baseUrl.toString())
  });
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });
  context.stdout.write(`Serving ${current.roomId} at ${normalizeBaseUrl(baseUrl.toString())}\n`);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

function participant(alias: string, kind: ParticipantKind, isHost: boolean, token: string): Participant {
  const now = new Date().toISOString();
  return {
    alias,
    kind,
    location: "local",
    install: isHost ? "host" : "lite",
    attention: isHost ? "attending" : "manual",
    is_host: isHost,
    token_hash: participantTokenHash(token),
    joinedAt: now,
    lastSeenAt: now
  };
}

function parseKind(value: string): ParticipantKind {
  if (value === "agent" || value === "human") return value;
  throw new Error("kind must be agent or human");
}

function emit(context: CliContext, json: boolean, value: unknown, text?: string): number {
  if (json) {
    context.stdout.write(`${JSON.stringify(value)}\n`);
  } else if (text !== undefined) {
    context.stdout.write(text);
  } else {
    context.stdout.write(`${JSON.stringify(value)}\n`);
  }
  return 0;
}
