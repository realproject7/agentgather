import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  addChannel,
  addForumComment,
  appendServerMessage,
  closeRoom,
  createBoardroom,
  createForumPost,
  createRoom,
  listForumPosts,
  readBoardroom,
  readChannelView,
  readForumPost,
  setForumPostStatus,
  writeChannelCursor,
  readBrief,
  readParticipants,
  readRoomState,
  roomPaths,
  updateAttendancePolicy,
  updateBrief,
  upsertParticipant,
  writeParticipants
} from "../../../storage/index.js";
import type { Channel, Participant, ParticipantKind, RoomBrief } from "../../../protocol/index.js";
import {
  assertSafeSlug,
  normalizeBaseUrl,
  parseAttendancePolicy,
  parseAttentionMode,
  parseChannelType,
  parseForumStatus,
  roomUrl,
  type AttendancePolicy
} from "../../../protocol/index.js";
import { createToken } from "../../../auth/index.js";
import {
  buildRuntimeLaunchPlan,
  createRoomHttpServer,
  participantTokenHash,
  renderInviteCard,
  resolveRuntimeState,
  sanitizePublicUrl,
  shellSingleQuote,
  type RuntimeLaunchPlan
} from "../../../server/index.js";
import { readPublicBaseUrl } from "../../../tunnel/index.js";
import { parseArgs, flagBoolean, flagString } from "../../args.js";
import type { CliContext } from "../../context.js";
import { readCurrent, readToken, writeCurrent, writeToken } from "../../state.js";

export async function runRoomCommand(argv: string[], context: CliContext): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "start") return roomStart(rest, context);
  if (subcommand === "create-boardroom") return roomCreateBoardroom(rest, context);
  if (subcommand === "channel-create") return roomChannelCreate(rest, context);
  if (subcommand === "channel-read") return roomChannelRead(rest, context);
  if (subcommand === "forum-post") return roomForumPost(rest, context);
  if (subcommand === "forum-comment") return roomForumComment(rest, context);
  if (subcommand === "forum-list") return roomForumList(rest, context);
  if (subcommand === "forum-read") return roomForumRead(rest, context);
  if (subcommand === "forum-status") return roomForumStatus(rest, context);
  if (subcommand === "boardroom") return roomBoardroom(rest, context);
  if (subcommand === "brief") return roomBrief(rest, context);
  if (subcommand === "attendance") return roomAttendance(rest, context);
  if (subcommand === "serve") return roomServe(rest, context);
  if (subcommand === "launch") return roomLaunch(rest, context);
  if (subcommand === "runtime-status") return roomRuntimeStatus(rest, context);
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
  // Host kind is modeled separately from the host role (V2 #169): an agent host
  // keeps is_host/ownership but groups under AGENTS. Defaults to human, so
  // existing rooms and the no-flag path are unchanged.
  const kind = parseKind(flagString(args, "kind") ?? "human");
  await createRoom({
    root: context.home,
    roomId,
    hostAlias: alias,
    briefBody,
    attendancePolicy: parseAttendancePolicy(flagString(args, "attendance") ?? "manual-ok"),
    ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt) })
  });
  await writeParticipants(context.home, roomId, [participant(alias, kind, true, token)]);
  await writeToken(context.home, roomId, alias, token);
  await writeCurrent(context.home, { roomId, alias, token, baseUrl });
  return emit(context, flagBoolean(args, "json"), { ok: true, room: roomId, alias, kind, token, baseUrl });
}

// Host create-boardroom flow (T7): create the room + host participant like
// `room start`, then materialize the boardroom with its channels (chat|forum
// chosen at creation, e.g. `--channels general:chat,design-forum:forum`).
async function roomCreateBoardroom(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const roomId = args.positional[0];
  if (roomId === undefined) throw new Error("room id is required");
  const alias = flagString(args, "alias") ?? "host";
  const baseUrl = normalizeBaseUrl(flagString(args, "url") ?? "http://127.0.0.1:8787");
  const token = createToken();
  const briefBody = flagString(args, "brief") ?? "";
  const expiresAt = flagString(args, "expires-at");
  const now = new Date();
  const channels = parseChannelSpec(flagString(args, "channels"), now.toISOString());
  // Host kind modeled separately from the host role (V2 #169); defaults to human.
  const kind = parseKind(flagString(args, "kind") ?? "human");
  await createRoom({
    root: context.home,
    roomId,
    hostAlias: alias,
    briefBody,
    attendancePolicy: parseAttendancePolicy(flagString(args, "attendance") ?? "manual-ok"),
    ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt) })
  });
  await writeParticipants(context.home, roomId, [participant(alias, kind, true, token)]);
  await writeToken(context.home, roomId, alias, token);
  await writeCurrent(context.home, { roomId, alias, token, baseUrl });
  const boardroomOptions: { name?: string; channels: Channel[] } = { channels };
  const boardroomName = flagString(args, "name");
  if (boardroomName !== undefined) boardroomOptions.name = boardroomName;
  const boardroom = await createBoardroom(context.home, roomId, boardroomOptions, now);
  // The host token is persisted to local state above; it is deliberately NOT
  // echoed here so the create response never carries a raw token (#144 gate).
  // Use `room invite` to mint shareable participant credentials.
  return emit(
    context,
    flagBoolean(args, "json"),
    { ok: true, room: roomId, alias, kind, baseUrl, boardroom },
    `Boardroom ${roomId} created with channels: ${boardroom.channels.map((c) => `#${c.id} (${c.type})`).join(", ")}\n` +
      "Host credentials saved locally. Use `room invite <name>` to invite participants.\n"
  );
}

// Host channel-create flow (T7): add a channel to the current boardroom,
// choosing its type at creation time.
async function roomChannelCreate(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const channelId = args.positional[0];
  if (channelId === undefined) throw new Error("channel id is required");
  const current = await readCurrent(context.home);
  const type = parseChannelType(flagString(args, "type") ?? "chat");
  const channel: Channel = {
    id: channelId,
    name: flagString(args, "name") ?? channelId,
    type,
    lifecycle: "active",
    createdAt: new Date().toISOString()
  };
  const boardroom = await addChannel(context.home, current.roomId, channel);
  return emit(
    context,
    flagBoolean(args, "json"),
    { ok: true, room: current.roomId, channel, boardroom },
    `Channel #${channelId} (${type}) added to ${current.roomId}\n`
  );
}

// Idle chat read (T5): inspect a channel's history + unread via the T3 read
// cursor WITHOUT entering foreground attended mode (no /wait, no attendance
// touch). #general projects the existing message log (no duplicated storage);
// `--mark-read` advances the channel cursor. Send/messages/watch/attend stay
// unchanged — this is an additive idle path.
async function roomChannelRead(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const channelId = args.positional[0] ?? "general";
  const current = await readCurrent(context.home);
  const participantId = flagString(args, "participant") ?? current.alias;
  const view = await readChannelView(context.home, current.roomId, channelId, participantId);
  let out = view;
  if (flagBoolean(args, "mark-read") && view.latestId > view.lastReadId) {
    await writeChannelCursor(context.home, current.roomId, channelId, participantId, view.latestId);
    out = { ...view, unread: 0, lastReadId: view.latestId };
  }
  return emit(
    context,
    flagBoolean(args, "json"),
    { ok: true, room: current.roomId, ...out },
    `#${channelId} (${out.type}): ${out.messages.length} messages, ${out.unread} unread (last read id ${out.lastReadId})\n`
  );
}

// Forum core (T6): host-owned, file-backed posts/comments on a T3 `forum`
// channel. These operate on the host's local files (no tokens in output).
async function roomForumPost(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const channelId = args.positional[0];
  if (channelId === undefined) throw new Error("forum channel id is required");
  const title = flagString(args, "title");
  if (title === undefined) throw new Error("--title is required");
  const current = await readCurrent(context.home);
  const input: { author: string; title: string; body: string; id?: string; status?: ReturnType<typeof parseForumStatus>; tags?: string[] } = {
    author: flagString(args, "author") ?? current.alias,
    title,
    body: flagString(args, "body") ?? ""
  };
  const id = flagString(args, "id");
  if (id !== undefined) input.id = id;
  const status = flagString(args, "status");
  if (status !== undefined) input.status = parseForumStatus(status);
  const tags = flagString(args, "tags");
  if (tags !== undefined) input.tags = tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  const post = await createForumPost(context.home, current.roomId, channelId, input);
  return emit(context, flagBoolean(args, "json"), { ok: true, post }, `forum post ${post.id} created in #${channelId} (${post.status})\n`);
}

async function roomForumComment(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const channelId = args.positional[0];
  const postId = args.positional[1];
  if (channelId === undefined || postId === undefined) throw new Error("forum-comment requires <channel> <post>");
  const body = flagString(args, "body") ?? args.positional.slice(2).join(" ");
  if (body.trim().length === 0) throw new Error("comment body is required");
  const current = await readCurrent(context.home);
  const comment = await addForumComment(context.home, current.roomId, channelId, postId, {
    author: flagString(args, "author") ?? current.alias,
    body
  });
  return emit(context, flagBoolean(args, "json"), { ok: true, comment }, `comment ${comment.id} added to ${postId}\n`);
}

async function roomForumList(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const channelId = args.positional[0];
  if (channelId === undefined) throw new Error("forum channel id is required");
  const current = await readCurrent(context.home);
  const posts = await listForumPosts(context.home, current.roomId, channelId);
  return emit(
    context,
    flagBoolean(args, "json"),
    { ok: true, posts },
    `${posts.map((p) => `${p.id} [${p.status}] ${p.title}`).join("\n")}\n`
  );
}

async function roomForumRead(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const channelId = args.positional[0];
  const postId = args.positional[1];
  if (channelId === undefined || postId === undefined) throw new Error("forum-read requires <channel> <post>");
  const current = await readCurrent(context.home);
  const thread = await readForumPost(context.home, current.roomId, channelId, postId);
  return emit(
    context,
    flagBoolean(args, "json"),
    { ok: true, ...thread },
    `${thread.post.title} [${thread.post.status}]\n${thread.post.body}\n--- ${thread.comments.length} comments ---\n`
  );
}

async function roomForumStatus(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const channelId = args.positional[0];
  const postId = args.positional[1];
  if (channelId === undefined || postId === undefined) throw new Error("forum-status requires <channel> <post>");
  const status = parseForumStatus(flagString(args, "status") ?? args.positional[2] ?? "");
  const current = await readCurrent(context.home);
  const post = await setForumPostStatus(context.home, current.roomId, channelId, postId, status);
  return emit(context, flagBoolean(args, "json"), { ok: true, post }, `forum post ${post.id} → ${post.status}\n`);
}

// View the current boardroom (channels + lifecycle). Carries no tokens.
async function roomBoardroom(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const current = await readCurrent(context.home);
  const boardroom = await readBoardroom(context.home, current.roomId);
  return emit(
    context,
    flagBoolean(args, "json"),
    { ok: true, boardroom },
    `${boardroom.channels.map((c) => `#${c.id} (${c.type}, ${c.lifecycle})`).join("\n")}\n`
  );
}

function parseChannelSpec(spec: string | undefined, createdAt: string): Channel[] {
  if (spec === undefined || spec.trim() === "") {
    return [{ id: "general", name: "general", type: "chat", lifecycle: "active", createdAt }];
  }
  return spec.split(",").map((entry) => {
    const [rawId, rawType] = entry.split(":");
    const id = (rawId ?? "").trim();
    return { id, name: id, type: parseChannelType((rawType ?? "chat").trim()), lifecycle: "active" as const, createdAt };
  });
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
  // 9A: the host may request an attention mode for this participant; the
  // effective mode is negotiated against the participant's declared support when
  // it joins.
  const invited = participant(alias, kind, false, token);
  const requestedMode = flagString(args, "mode");
  if (requestedMode !== undefined) invited.requested_mode = parseAttentionMode(requestedMode);
  // T10: designate a forum-review task so the Attend Card renders the forum
  // review section + commands for this channel.
  const forumChannel = flagString(args, "forum");
  if (forumChannel !== undefined) {
    assertSafeSlug(forumChannel, "forum channel");
    invited.forum_review_channel = forumChannel;
  }
  await upsertParticipant(context.home, current.roomId, invited);
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
  const participant = (await readParticipants(roomPaths(context.home, current.roomId))).find((entry) => entry.alias === alias);
  if (participant === undefined) throw new Error(`participant not found: ${alias}`);
  const advertised = advertisedBaseUrl(context.home, current.roomId, current.baseUrl);
  const card = renderInviteCard(advertised, participant, token, brief, state.attendance_policy);
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

// Host runtime launch handoff (T7A): build a launch plan for keeping the room
// live. With a detachable runner (tmux) `--detach` launches `room serve` in a
// detached session so the agent host never holds the server in the foreground;
// otherwise it prints a copy-pastable command block for a human operator. The
// plan carries no tokens.
async function roomLaunch(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const current = await readCurrent(context.home);
  const currentUrl = new URL(current.baseUrl);
  const port = Number(flagString(args, "port") ?? (currentUrl.port || "8787"));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  const publicUrl = sanitizePublicUrl(normalizeBaseUrl(flagString(args, "url") ?? current.baseUrl));
  const sessionName = flagString(args, "session") ?? `agentgather-${current.roomId}`;
  const logPath = flagString(args, "log") ?? path.join(context.home, "rooms", current.roomId, "serve.log");
  const tmuxAvailable = await hasCommand("tmux");
  const runtimeReachable = await probeRuntime(publicUrl);
  const cli = resolveHostCli();
  const plan = buildRuntimeLaunchPlan({
    home: context.home,
    roomId: current.roomId,
    port,
    publicUrl,
    logPath,
    sessionName,
    tmuxAvailable,
    runtimeReachable,
    cliInvocation: cli.invocation,
    cliResolved: cli.resolved
  });

  let launched = false;
  if (flagBoolean(args, "detach")) {
    if (!tmuxAvailable || plan.detachedCommand === null) {
      throw new Error("--detach requires a detachable runner (tmux); none found — run the printed command manually");
    }
    await execFileAsync("tmux", [
      "new-session",
      "-d",
      "-s",
      sessionName,
      `${plan.serveCommand} >> ${shellSingleQuote(logPath)} 2>&1`
    ]);
    launched = true;
  }

  return emit(context, flagBoolean(args, "json"), { ok: true, room: current.roomId, launched, ...plan }, renderLaunchText(plan, launched));
}

// Surface host runtime state only: runtime-running / runtime-unreachable /
// manual-run-required (token-free).
async function roomRuntimeStatus(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const current = await readCurrent(context.home);
  const publicUrl = sanitizePublicUrl(normalizeBaseUrl(flagString(args, "url") ?? current.baseUrl));
  const [tmuxAvailable, runtimeReachable] = await Promise.all([hasCommand("tmux"), probeRuntime(publicUrl)]);
  const runtimeState = resolveRuntimeState(tmuxAvailable, runtimeReachable);
  // Surface the host CLI source here too (directive: "command/status output"),
  // so a relaunch uses the host's own CLI rather than a global one.
  const cli = resolveHostCli();
  return emit(
    context,
    flagBoolean(args, "json"),
    {
      ok: true,
      room: current.roomId,
      runtime_state: runtimeState,
      tmux_available: tmuxAvailable,
      cli_source: cli.invocation,
      cli_resolved: cli.resolved
    },
    `runtime: ${runtimeState}\ncli: ${cli.invocation}\n`
  );
}

// Resolve the host's own CLI invocation (node + entry script) so generated
// commands relaunch the same CLI/build the host runs, not a global `agentgather`.
function resolveHostCli(): { invocation: string; resolved: boolean } {
  const entry = process.argv[1];
  if (typeof entry === "string" && entry.length > 0) {
    return { invocation: `${shellSingleQuote(process.execPath)} ${shellSingleQuote(entry)}`, resolved: true };
  }
  return { invocation: "agentgather", resolved: false };
}

function renderLaunchText(plan: RuntimeLaunchPlan, launched: boolean): string {
  const lines = [`runtime: ${plan.runtimeState}`, `cli: ${plan.cliSource}`, plan.ownership, ""];
  if (plan.strategy === "detached-tmux") {
    lines.push(launched ? `Launched detached session "${plan.sessionName}".` : "Run this to launch a detached runtime:");
    if (!launched && plan.detachedCommand !== null) lines.push(`  ${plan.detachedCommand}`);
    lines.push(`Log:    ${plan.logPath}`, `Status: ${plan.statusCommand}`, `Stop:   ${plan.stopCommand}`);
  } else {
    lines.push("No detachable runner found — a human operator should run:", `  ${plan.serveCommand}`, `Status: ${plan.statusCommand}`, `Stop:   ${plan.stopCommand}`);
  }
  return `${lines.join("\n")}\n`;
}

const execFileAsync = promisify(execFile);

async function hasCommand(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["-V"]);
    return true;
  } catch {
    return false;
  }
}

async function probeRuntime(publicUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    await fetch(publicUrl, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
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
