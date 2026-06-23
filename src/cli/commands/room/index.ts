import {
  appendServerMessage,
  closeRoom,
  createRoom,
  readBrief,
  readParticipants,
  readRoomState,
  roomPaths,
  updateAttendancePolicy,
  updateBrief,
  upsertParticipant,
  writeParticipants
} from "../../../storage/index.js";
import type { Participant, ParticipantKind, RoomBrief } from "../../../protocol/index.js";
import { normalizeBaseUrl, parseAttendancePolicy, roomUrl, type AttendancePolicy } from "../../../protocol/index.js";
import { createToken } from "../../../auth/index.js";
import { createRoomHttpServer, participantTokenHash, renderAttendCard } from "../../../server/index.js";
import { readPublicBaseUrl } from "../../../tunnel/index.js";
import { parseArgs, flagBoolean, flagString } from "../../args.js";
import type { CliContext } from "../../context.js";
import { readCurrent, readToken, writeCurrent, writeToken } from "../../state.js";

export async function runRoomCommand(argv: string[], context: CliContext): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "start") return roomStart(rest, context);
  if (subcommand === "brief") return roomBrief(rest, context);
  if (subcommand === "attendance") return roomAttendance(rest, context);
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
    attendancePolicy: parseAttendancePolicy(flagString(args, "attendance") ?? "manual-ok"),
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

async function roomAttendance(argv: string[], context: CliContext): Promise<number> {
  const [action, ...rest] = argv;
  const current = await readCurrent(context.home);
  const args = parseArgs(rest);
  if (action === "view") {
    const state = await readRoomState(roomPaths(context.home, current.roomId));
    return emit(
      context,
      flagBoolean(args, "json"),
      { ok: true, attendance_policy: state.attendance_policy },
      `${state.attendance_policy}\n`
    );
  }
  if (action === "set") {
    const policy = parseAttendancePolicy(flagString(args, "policy") ?? args.positional[0] ?? "");
    const state =
      (await postAttendanceToServer(current.baseUrl, current.token, policy)) ??
      (await updateAttendancePolicyDirect(context, current.roomId, current.alias, policy));
    return emit(context, flagBoolean(args, "json"), { ok: true, attendance_policy: state.attendance_policy });
  }
  throw new Error("room attendance requires view or set");
}

async function postAttendanceToServer(
  baseUrl: string,
  token: string,
  policy: AttendancePolicy
): Promise<{ attendance_policy: AttendancePolicy } | null> {
  try {
    const response = await fetch(roomUrl(baseUrl, "/attendance"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ policy })
    });
    const payload = await readResponseJson<{ attendance_policy?: AttendancePolicy; message?: string }>(response);
    if (response.status === 404) return null;
    if (!response.ok || payload.attendance_policy === undefined) {
      throw new Error(payload.message ?? `attendance update failed with HTTP ${response.status}`);
    }
    return { attendance_policy: payload.attendance_policy };
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

async function updateAttendancePolicyDirect(
  context: CliContext,
  roomId: string,
  alias: string,
  policy: AttendancePolicy
): Promise<{ attendance_policy: AttendancePolicy }> {
  const state = await updateAttendancePolicy({
    root: context.home,
    roomId,
    policy,
    updatedBy: alias
  });
  await appendServerMessage({
    root: context.home,
    roomId,
    from: "system",
    text: `Attendance policy set to ${state.attendance_policy}`
  });
  return { attendance_policy: state.attendance_policy };
}

async function postBriefToServer(baseUrl: string, token: string, body: string): Promise<RoomBrief | null> {
  try {
    const response = await fetch(roomUrl(baseUrl, "/brief"), {
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
  const advertised = advertisedBaseUrl(context.home, current.roomId, current.baseUrl);
  const cardCommand = `curl -s "${roomUrl(advertised, `/card?participant=${alias}&token=${token}`)}"`;
  const browserUrl = `${normalizeBaseUrl(advertised)}/#token=${token}`;
  return emit(
    context,
    flagBoolean(args, "json"),
    { ok: true, room: current.roomId, alias, kind, token, card_command: cardCommand, browser_url: browserUrl },
    `Invite ${alias}:\n${kind === "human" ? `Open: ${browserUrl}\n` : ""}${cardCommand}\n`
  );
}

async function roomInviteCard(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const alias = args.positional[0];
  if (alias === undefined) throw new Error("participant alias is required");
  const current = await readCurrent(context.home);
  const token = await readToken(context.home, current.roomId, alias);
  const [brief, state] = await Promise.all([
    readBrief(context.home, current.roomId),
    readRoomState(roomPaths(context.home, current.roomId))
  ]);
  const advertised = advertisedBaseUrl(context.home, current.roomId, current.baseUrl);
  const card = renderAttendCard(advertised, alias, token, brief, state.attendance_policy);
  return emit(context, flagBoolean(args, "json"), { ok: true, room: current.roomId, alias, card }, `${card}\n`);
}

// Prefer the published broker URL (from tunnel.json) so invite output stays on
// the public URL even after `room serve` rewrites current.baseUrl to a local
// address. Falls back to the stored room URL when no tunnel is active.
function advertisedBaseUrl(home: string, roomId: string, fallback: string): string {
  return readPublicBaseUrl(home, roomId) ?? fallback;
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
  const currentUrl = new URL(current.baseUrl);
  const portValue = flagString(args, "port") ?? (currentUrl.port || "8787");
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  const host = flagString(args, "host") ?? "127.0.0.1";
  const allowRemote = flagBoolean(args, "allow-remote");
  const publicUrl = new URL(flagString(args, "url") ?? current.baseUrl);
  if (flagString(args, "url") === undefined) publicUrl.port = String(port);
  validateServeExposure({ host, publicUrl, allowRemote });
  const localBaseUrl = normalizeBaseUrl(publicUrl.toString());
  const server = createRoomHttpServer({
    root: context.home,
    roomId: current.roomId,
    baseUrl: localBaseUrl,
    allowInsecureRemote: allowRemote,
    // After `tunnel start` publishes a broker URL, advertise it in cards and
    // wait commands; otherwise keep advertising the local serve URL.
    publicBaseUrl: () => readPublicBaseUrl(context.home, current.roomId) ?? localBaseUrl
  });
  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });
  await writeCurrent(context.home, { ...current, baseUrl: localBaseUrl });
  context.stdout.write(`Serving ${current.roomId} at ${localBaseUrl}\n`);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

function validateServeExposure(options: { host: string; publicUrl: URL; allowRemote: boolean }): void {
  if (options.publicUrl.protocol !== "http:" && options.publicUrl.protocol !== "https:") {
    throw new Error("--url must use http or https");
  }
  const localBind = isLocalBindHost(options.host);
  const localPublicUrl = isLocalhostName(options.publicUrl.hostname);
  if (!options.allowRemote && (!localBind || !localPublicUrl)) {
    throw new Error("remote room serving requires --allow-remote");
  }
  if (options.allowRemote && !localPublicUrl && options.publicUrl.protocol !== "https:") {
    throw new Error("remote public URLs must use https");
  }
}

function isLocalBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isLocalhostName(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
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
