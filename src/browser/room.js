import { analyzeMentions } from "./mentions.js";
import { renderSafeMarkdown } from "./markdown.js";

const state = {
  token: null,
  cursor: 0,
  seen: new Set(),
  participants: new Set(),
  participantLabels: new Map(),
  participantKinds: new Map(),
  participantHosts: new Map(),
  attending: new Set(),
  profile: null,
  roomStatus: "open",
  briefVersion: 0,
  replyTo: null,
  composing: false,
  sendInFlight: false,
  pendingSend: null,
  broadcast: false,
  // Route/relay connection health, distinct from room open/closed lifecycle.
  // "live" | "degraded" | "quota". Closed is tracked by roomStatus.
  connection: "live",
  connectionCode: null,
  // Whether GET /messages reached the host log (true) or failed (false), used to
  // tell a closed room's read-only host history apart from "unavailable".
  historyAvailable: true,
  closedHistoryLoaded: false,
  lastMessageTs: null
};

const shell = document.querySelector(".room-shell");
const authError = document.getElementById("auth-error");
const joinPanel = document.getElementById("join-panel");
const joinForm = document.getElementById("join-form");
const displayNameInput = document.getElementById("display-name");
const joinError = document.getElementById("join-error");
const roomTitle = document.getElementById("room-title");
const roomStatus = document.getElementById("room-status");
const attendancePolicy = document.getElementById("attendance-policy");
const participantCount = document.getElementById("participant-count");
const rosterRoomStatus = document.getElementById("roster-room-status");
const rosterAttendancePolicy = document.getElementById("roster-attendance-policy");
const rosterLastMessage = document.getElementById("roster-last-message");
const briefOpen = document.getElementById("brief-open");
const briefClose = document.getElementById("brief-close");
const briefOverlay = document.getElementById("brief-overlay");
const briefSummary = document.getElementById("brief-summary");
const briefRoomName = document.getElementById("brief-room-name");
const briefVersion = document.getElementById("brief-version");
const briefBody = document.getElementById("brief-body");
const briefRefresh = document.getElementById("brief-refresh");
const emptyState = document.getElementById("empty-state");
const timeline = document.getElementById("timeline");
const systemFilter = document.getElementById("system-filter");
const participantList = document.getElementById("participant-list");
const rosterToggle = document.getElementById("roster-toggle");
const composer = document.getElementById("composer");
const messageText = document.getElementById("message-text");
const sendButton = document.getElementById("send-button");
const sendError = document.getElementById("send-error");
const replyIndicator = document.getElementById("reply-indicator");
const closeButton = document.getElementById("close-button");
const exportButton = document.getElementById("export-button");
const hostControls = document.getElementById("host-controls");
const inviteButton = document.getElementById("invite-button");
const inviteNote = document.getElementById("invite-note");
const railBroadcast = document.getElementById("rail-broadcast");
const rsActive = document.getElementById("rs-active");
const broadcastToggle = document.getElementById("broadcast-toggle");
const modeNote = document.getElementById("mode-note");
const composerIdentity = document.getElementById("composer-identity");
const mentionWarning = document.getElementById("mention-warning");
const mentionAutocomplete = document.getElementById("mention-autocomplete");
const roomBanner = document.getElementById("room-banner");
const bannerTitle = document.getElementById("banner-title");
const bannerDetail = document.getElementById("banner-detail");
const bannerAction = document.getElementById("banner-action");
const historyStrip = document.getElementById("history-strip");
const historySourceTag = document.getElementById("history-source-tag");
const historySourceNote = document.getElementById("history-source-note");
const historySummary = document.getElementById("history-summary");
const historyFootNote = document.getElementById("history-foot-note");
const historyKv = document.getElementById("history-kv");

init().catch((error) => showError(error instanceof Error ? error.message : String(error)));

async function init() {
  const token = tokenFromFragment() || sessionStorage.getItem("agentgather.token");
  if (!token) {
    authError.hidden = false;
    shell.dataset.state = "auth-error";
    window.addEventListener("hashchange", () => {
      const nextToken = tokenFromFragment();
      if (nextToken) {
        authError.hidden = true;
        void startWithToken(nextToken);
      }
    });
    return;
  }
  await startWithToken(token);
}

async function startWithToken(token) {
  state.token = token;
  sessionStorage.setItem("agentgather.token", state.token);
  state.profile = (await authFetch("/profile")).participant;
  if (state.profile.kind === "human" && !state.profile.display_name) {
    joinPanel.hidden = false;
    shell.dataset.state = "joining";
    bindJoinForm();
    return;
  }
  await enterRoom();
}

async function enterRoom() {
  joinPanel.hidden = true;
  await Promise.all([loadBrief(), loadStatus()]);
  await pollMessages();
  setInterval(() => void pollMessages(), 3000);
  setInterval(() => void loadStatus(), 5000);
  bindEvents();
}

function bindJoinForm() {
  joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitProfile();
  });
}

async function submitProfile() {
  joinError.hidden = true;
  const displayName = displayNameInput.value.trim();
  if (!displayName) return;
  try {
    const payload = await authFetch("/profile", {
      method: "POST",
      body: JSON.stringify({ display_name: displayName })
    });
    state.profile = payload.participant;
    await enterRoom();
  } catch (error) {
    joinError.hidden = false;
    joinError.textContent = error instanceof Error ? error.message : String(error);
  }
}

function bindEvents() {
  rosterToggle.addEventListener("click", () => shell.classList.toggle("roster-open"));
  briefRefresh.addEventListener("click", () => void loadBrief());
  briefOpen.addEventListener("click", () => openBriefOverlay());
  briefClose.addEventListener("click", () => closeBriefOverlay());
  briefOverlay.addEventListener("click", (event) => {
    if (event.target === briefOverlay) closeBriefOverlay();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !briefOverlay.hidden) closeBriefOverlay();
  });
  systemFilter.addEventListener("change", () => {
    timeline.classList.toggle("hide-system", !systemFilter.checked);
  });
  messageText.addEventListener("input", () => {
    clearPendingSendIfTextChanged();
    autoGrowComposer();
    updateComposerHints();
  });
  messageText.addEventListener("compositionstart", () => {
    state.composing = true;
  });
  messageText.addEventListener("compositionend", () => {
    state.composing = false;
  });
  messageText.addEventListener("keydown", (event) => {
    // While the autocomplete is open, Enter/Tab accepts the top match instead of
    // sending, and Escape dismisses it.
    if (!mentionAutocomplete.hidden) {
      if (event.key === "Escape") {
        event.preventDefault();
        hideAutocomplete();
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.isComposing) {
        const first = mentionAutocomplete.querySelector(".ac-option");
        if (first) {
          event.preventDefault();
          applyMention(first.dataset.alias);
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !state.composing) {
      event.preventDefault();
      void submitMessage();
    }
  });
  messageText.addEventListener("blur", () => {
    // Defer so a click on a suggestion still registers before the list hides.
    setTimeout(() => hideAutocomplete(), 120);
  });
  broadcastToggle.addEventListener("click", () => setBroadcast(!state.broadcast));
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitMessage();
  });
  closeButton.addEventListener("click", () => void closeRoom());
  exportButton.addEventListener("click", exportRoom);
  railBroadcast.addEventListener("click", () => {
    setBroadcast(true);
    messageText.focus();
  });
  inviteButton.addEventListener("click", () => {
    inviteNote.hidden = !inviteNote.hidden;
    if (!inviteNote.hidden && !inviteNote.textContent) {
      // No browser invite endpoint — invites are host-owned and generated by the
      // CLI (which mints the token). Surface the real command, never a fake action.
      inviteNote.textContent = "Generate role-specific invites from the host CLI: agentgather room invite <alias> [--kind agent|human]";
    }
  });
}

function tokenFromFragment() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get("token");
  if (token) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return token;
}

async function loadBrief() {
  const payload = await authFetch("/brief");
  const brief = payload.brief;
  const changed = state.briefVersion !== 0 && state.briefVersion !== brief.brief_version;
  state.briefVersion = brief.brief_version;
  briefVersion.textContent = changed ? `v${brief.brief_version} updated` : `v${brief.brief_version}`;
  briefRefresh.hidden = true;
  const body = brief.body || "(empty)";
  briefSummary.textContent = summarizeBrief(body);
  renderSafeMarkdown(briefBody, body, { mentions: state.participants });
}

async function loadStatus() {
  let payload;
  try {
    payload = await authFetch("/status");
  } catch (error) {
    handlePollError(error);
    return;
  }
  markConnectionLive();
  state.roomStatus = payload.room_status;
  roomTitle.textContent = payload.room;
  briefRoomName.textContent = payload.room;
  roomStatus.textContent = payload.room_status;
  roomStatus.dataset.status = payload.room_status;
  attendancePolicy.textContent = payload.attendance_policy || "manual-ok";
  rosterRoomStatus.textContent = payload.room_status;
  rosterAttendancePolicy.textContent = payload.attendance_policy || "manual-ok";
  if (payload.brief_version > state.briefVersion) {
    briefRefresh.hidden = false;
    briefVersion.textContent = `v${payload.brief_version} available`;
  }
  state.participants = new Set(payload.participants.map((participant) => participant.alias));
  state.participantLabels = new Map(
    payload.participants.map((participant) => [participant.alias, participant.display_name || participant.alias])
  );
  state.participantKinds = new Map(payload.participants.map((participant) => [participant.alias, participant.kind]));
  state.participantHosts = new Map(payload.participants.map((participant) => [participant.alias, Boolean(participant.is_host)]));
  state.attending = new Set(
    payload.participants
      .filter((participant) => isForegroundState(participant.attendance_state || participant.attention))
      .map((participant) => participant.alias)
  );
  participantCount.textContent = `${payload.participants.length} participants`;
  renderParticipants(payload.participants);
  updateComposerIdentity(payload.participants);
  updateLastMessage();
  // Host-only control section; the room-state segment reflects the real lifecycle
  // (open -> active, closed -> close). idle/pause are platform-managed and stay
  // disabled in a local host room (no fabricated state transitions).
  hostControls.hidden = !payload.is_host;
  rsActive.classList.toggle("on", payload.room_status !== "closed");
  closeButton.classList.toggle("on", payload.room_status === "closed");
  updateJoinFlips();
  applyRoomState();
}

async function pollMessages() {
  // A closed room is loaded exactly once: GET /messages still serves the host's
  // read-only history (it never required the room to be open), but there is
  // nothing further to poll for.
  if (state.roomStatus === "closed" && state.closedHistoryLoaded) return;
  let payload;
  try {
    payload = await authFetch(`/messages?since_id=${state.cursor}`);
  } catch (error) {
    state.historyAvailable = false;
    handlePollError(error);
    if (state.roomStatus === "closed") {
      state.closedHistoryLoaded = true;
      applyRoomState();
    }
    return;
  }
  markConnectionLive();
  state.historyAvailable = true;
  for (const message of payload.messages) {
    if (state.seen.has(message.id)) continue;
    state.seen.add(message.id);
    renderMessage(message);
    if (message.ts) state.lastMessageTs = message.ts;
  }
  updateLastMessage();
  state.cursor = payload.next_since_id;
  emptyState.hidden = state.seen.size > 0 || state.roomStatus === "closed";
  if (state.roomStatus === "closed") {
    state.closedHistoryLoaded = true;
    applyRoomState();
  }
}

function isForegroundState(value) {
  return value === "attending" || value === "managed";
}

async function submitMessage() {
  if (state.sendInFlight) return;
  const text = messageText.value.trim();
  if (!text) return;
  sendError.hidden = true;
  hideAutocomplete();
  const broadcast = state.broadcast;
  const pending = ensurePendingSend(text, state.replyTo);
  const body = { text, client_msg_id: pending.clientMsgId };
  if (pending.replyTo !== null) body.reply_to = pending.replyTo;
  // Broadcast reuses the existing untargeted "status" message type — no new
  // schema, no @alias required.
  if (broadcast) body.type = "status";
  let payload;
  state.sendInFlight = true;
  setComposerDisabled(true);
  try {
    payload = await authFetch("/messages", {
      method: "POST",
      body: JSON.stringify(body)
    });
  } catch (error) {
    sendError.hidden = false;
    sendError.textContent = error instanceof Error ? error.message : String(error);
    state.sendInFlight = false;
    setComposerDisabled(state.roomStatus === "closed");
    // Only route/quota/transport failures drive the connection banner; ordinary
    // send rejections (rate_limited, loop_guard, message_too_large) stay inline.
    if (isConnectionError(error)) handlePollError(error);
    return;
  }
  messageText.value = "";
  state.replyTo = null;
  state.pendingSend = null;
  state.sendInFlight = false;
  setComposerDisabled(state.roomStatus === "closed");
  replyIndicator.hidden = true;
  hideMentionWarning();
  // A broadcast is a deliberate one-shot; return to direct so the next message
  // is not accidentally sent room-wide.
  if (broadcast) setBroadcast(false);
  autoGrowComposer();
  if (payload.message && !state.seen.has(payload.message.id)) {
    state.seen.add(payload.message.id);
    renderMessage(payload.message);
    state.cursor = Math.max(state.cursor, payload.message.id);
    emptyState.hidden = true;
    // Mirror the poll path so the rail "last message" KV reflects our own send
    // immediately (the poll skips this id since it is already in state.seen). (#121)
    if (payload.message.ts) state.lastMessageTs = payload.message.ts;
    updateLastMessage();
  }
}

async function closeRoom() {
  const payload = await authFetch("/close", { method: "POST" });
  state.roomStatus = payload.room_status;
  await loadStatus();
}

function exportRoom() {
  const rows = [...timeline.querySelectorAll(".message")].map((row) => row.textContent.trim());
  const blob = new Blob([rows.join("\n\n")], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "agentgather-room.txt";
  link.click();
  URL.revokeObjectURL(link.href);
}

function openBriefOverlay() {
  briefOverlay.hidden = false;
  briefClose.focus();
}

function closeBriefOverlay() {
  briefOverlay.hidden = true;
  briefOpen.focus();
}

async function authFetch(path, options = {}) {
  // Resolve room API paths relative to the document base so the app works both
  // when served locally at "/" and through a broker at "/<slug>/".
  const target = new URL(path.replace(/^\//, ""), document.baseURI);
  const response = await fetch(target, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload.message || `HTTP ${response.status}`);
    // Preserve the machine-readable code (e.g. quota_exceeded, host_unavailable,
    // route_closed) so banner logic reuses the existing taxonomy.
    error.code = payload.error;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function renderParticipants(participants) {
  participantList.replaceChildren();
  // Group humans and agents with counts (#115); kind is then implied by the
  // group header so each card can drop the noisy kind/location/install meta.
  renderParticipantGroup("humans", participants.filter((p) => p.kind !== "agent"));
  renderParticipantGroup("agents", participants.filter((p) => p.kind === "agent"));
}

function renderParticipantGroup(label, group) {
  if (group.length === 0) return;
  const header = document.createElement("li");
  header.className = "rail-group";
  const title = document.createElement("span");
  title.textContent = label;
  const count = document.createElement("span");
  count.className = "rail-group-count";
  count.textContent = String(group.length);
  header.append(title, count);
  participantList.append(header);
  for (const participant of group) {
    const item = document.createElement("li");
    item.className = "participant";
    item.dataset.attendanceState = participant.attendance_state || participant.attention;
    item.dataset.kind = participant.kind;
    item.dataset.host = participant.is_host ? "true" : "false";
    const name = document.createElement("strong");
    name.textContent = participant.display_name || participant.alias;
    const status = document.createElement("span");
    status.className = "participant-status k-pill";
    status.textContent = participantStatusText(participant);
    const meta = document.createElement("span");
    const aliasPart =
      participant.display_name && participant.display_name !== participant.alias ? `@${participant.alias} · ` : "";
    const hostPart = participant.is_host ? "host · " : "";
    // 9A: show the negotiated effective attention mode; when degraded (the host
    // requested a more capable mode than the participant can provide) show both
    // as `requested→effective`. effective_mode is always a declared mode or the
    // manual floor, so the roster never claims an undeclared capability.
    const modePart = participant.effective_mode
      ? `${participant.requested_mode && participant.requested_mode !== participant.effective_mode ? `${participant.requested_mode}→` : ""}${participant.effective_mode} · `
      : "";
    meta.textContent = `${aliasPart}${hostPart}${modePart}${formatRelative(participant.lastSeenAt)}`;
    item.append(name, status, meta);
    participantList.append(item);
  }
}

function updateComposerIdentity(participants) {
  if (!state.profile || !composerIdentity) return;
  const me = participants.find((participant) => participant.alias === state.profile.alias);
  const name = (me && (me.display_name || me.alias)) || state.profile.display_name || state.profile.alias;
  const presence = me ? me.attendance_state || me.attention : null;
  composerIdentity.textContent = presence ? `${name} · ${presence}` : name;
}

function updateLastMessage() {
  if (!rosterLastMessage) return;
  rosterLastMessage.textContent = state.lastMessageTs ? formatAgo(state.lastMessageTs) : "—";
}

function participantStatusText(participant) {
  const state = participant.attendance_state || participant.attention;
  if (state === "stale") return "stale";
  if (state === "not_attending") return "not attending";
  return state;
}

function renderMessage(message) {
  const item = document.createElement("li");
  item.className = `message ${message.type === "system" ? "system" : ""}`;
  if (message.type === "status") item.classList.add("broadcast");
  if (state.profile && message.from === state.profile.alias) item.classList.add("own");
  item.dataset.messageId = String(message.id);

  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = message.ts;
  time.textContent = formatTime(message.ts);

  if (message.type === "system") {
    const pill = document.createElement("div");
    pill.className = "system-pill";
    const text = document.createElement("span");
    text.className = "message-text";
    renderSafeMarkdown(text, message.text, { compact: true, mentions: state.participants });
    pill.append(time, text);
    // First-join visibility: a "<alias> joined" line gains a live presence flag
    // that turns to "now attending" once that participant is foreground (#74).
    const joined = /^(@?[a-z0-9-]+) joined$/.exec(message.text.trim());
    if (joined) {
      const alias = joined[1].replace(/^@/, "");
      const flip = document.createElement("span");
      flip.className = "joinflip";
      flip.dataset.alias = alias;
      flip.hidden = !state.attending.has(alias);
      const dot = document.createElement("span");
      dot.className = "joinflip-dot";
      dot.setAttribute("aria-hidden", "true");
      flip.append(dot, document.createTextNode("now attending"));
      pill.append(flip);
    }
    item.append(pill);
    timeline.append(item);
    item.scrollIntoView({ block: "nearest" });
    return;
  }

  const from = document.createElement("div");
  from.className = "message-from";
  from.textContent = state.participantLabels.get(message.from) || message.from;
  const senderKind = state.participantKinds.get(message.from) || "human";
  from.dataset.kind = senderKind;

  const avatar = document.createElement("div");
  avatar.className = `message-avatar ${senderKind === "agent" ? "agent" : "human"}`;
  avatar.textContent = initialsFor(state.participantLabels.get(message.from) || message.from);

  const text = document.createElement("div");
  text.className = "message-text";
  renderSafeMarkdown(text, message.text, { mentions: state.participants });

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.append(from);
  if (message.type === "status") {
    const chip = document.createElement("span");
    chip.className = "broadcast-chip";
    chip.textContent = "◆ broadcast";
    meta.append(chip);
  }
  meta.append(time);

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.append(meta, text);

  item.addEventListener("dblclick", () => setReply(message));
  item.dataset.senderKind = senderKind;
  item.append(avatar, bubble);
  timeline.append(item);
  item.scrollIntoView({ block: "nearest" });
}

function setReply(message) {
  state.replyTo = message.id;
  clearPendingSendIfTextChanged();
  replyIndicator.hidden = false;
  replyIndicator.textContent = `Replying to ${message.from} #${message.id}`;
  messageText.focus();
}

function ensurePendingSend(text, replyTo) {
  if (state.pendingSend && state.pendingSend.text === text && state.pendingSend.replyTo === replyTo) {
    return state.pendingSend;
  }
  state.pendingSend = {
    text,
    replyTo,
    clientMsgId: `browser-${crypto.randomUUID()}`
  };
  return state.pendingSend;
}

function clearPendingSendIfTextChanged() {
  if (!state.pendingSend) return;
  if (state.pendingSend.text !== messageText.value.trim() || state.pendingSend.replyTo !== state.replyTo) {
    state.pendingSend = null;
  }
}

function setComposerDisabled(disabled) {
  messageText.disabled = disabled;
  sendButton.disabled = disabled;
  composer.dataset.pending = state.sendInFlight ? "true" : "false";
}


function summarizeBrief(body) {
  const lines = String(body || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const isHeading = (line) => /^#{1,6}\s+/.test(line);
  const strip = (line) =>
    line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^[-*]\s+/, "")
      .replace(/\*\*|`|\[|\]\([^)]+\)/g, "")
      .trim();
  // Prefer the first prose line so a leading "## Goal" heading does not become
  // the whole summary; fall back to the first heading, then "(empty)".
  const pick = lines.find((line) => !isHeading(line)) || lines[0] || "";
  const clean = strip(pick) || "(empty)";
  // Keep the collapsed bar to a short lead-in even when the brief is one long
  // line; the full text lives in the brief overlay (CSS also ellipsis-clips).
  return clean.length > 120 ? `${clean.slice(0, 117).trimEnd()}…` : clean;
}

// ---- composer: broadcast mode (#72) ----
function setBroadcast(on) {
  state.broadcast = on;
  // Broadcast vs direct is conveyed by the mode chip, the "untargeted" note, and
  // the accent composer border (all keyed off data-mode), so the field hint does
  // not need to change.
  composer.dataset.mode = on ? "broadcast" : "direct";
  broadcastToggle.setAttribute("aria-pressed", String(on));
  if (on) {
    hideMentionWarning();
    hideAutocomplete();
  } else {
    updateComposerHints();
  }
}

// ---- composer: unknown-mention warning + autocomplete (#71) ----
function updateComposerHints() {
  if (state.broadcast) {
    hideMentionWarning();
    hideAutocomplete();
    return;
  }
  updateMentionWarning();
  updateAutocomplete();
}

function updateMentionWarning() {
  const { unknown } = analyzeMentions(messageText.value, state.participants);
  if (unknown.length === 0) {
    hideMentionWarning();
    return;
  }
  mentionWarning.replaceChildren();
  const lead = document.createElement("span");
  lead.className = "warn-lead";
  const tokens = unknown.map((alias) => `@${alias}`).join(", ");
  lead.append(document.createTextNode(`${tokens} ${unknown.length > 1 ? "are" : "is"} not in this room`));
  mentionWarning.append(lead);

  const suggestions = suggestionsFor(unknown[0]);
  if (suggestions.length > 0) {
    mentionWarning.append(document.createTextNode(" — did you mean "));
    suggestions.forEach((alias, index) => {
      if (index > 0) mentionWarning.append(document.createTextNode(" "));
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "warn-suggest";
      chip.dataset.alias = alias;
      chip.textContent = `@${alias}`;
      chip.addEventListener("click", () => replaceUnknownToken(unknown[0], alias));
      mentionWarning.append(chip);
    });
    mentionWarning.append(document.createTextNode("?"));
  } else {
    mentionWarning.append(document.createTextNode(" — it will not be delivered as a mention."));
  }
  mentionWarning.hidden = false;
}

function hideMentionWarning() {
  mentionWarning.hidden = true;
  mentionWarning.replaceChildren();
}

// Candidate aliases for an unknown @token: prefix matches first, then any alias
// that shares the prefix, capped to keep the hint compact.
function suggestionsFor(token) {
  const aliases = [...state.participants];
  const prefix = aliases.filter((alias) => alias.startsWith(token) || token.startsWith(alias));
  const contains = aliases.filter((alias) => !prefix.includes(alias) && alias.includes(token));
  return [...prefix, ...contains].slice(0, 3);
}

function replaceUnknownToken(from, to) {
  // A negative lookahead (not \b) so a token ending in "-" still matches: \b
  // would not fire between "-" and the following character.
  const pattern = new RegExp(`(^|[^\\w-])@${from}(?![a-z0-9-])`);
  messageText.value = messageText.value.replace(pattern, (_match, lead) => `${lead}@${to}`);
  messageText.focus();
  updateComposerHints();
}

// Live participant autocomplete while typing an @token before the caret.
function updateAutocomplete() {
  const caret = messageText.selectionStart ?? messageText.value.length;
  const before = messageText.value.slice(0, caret);
  const active = /(^|[^\w-])@([a-z0-9-]*)$/.exec(before);
  if (active === null) {
    hideAutocomplete();
    return;
  }
  const partial = active[2].toLowerCase();
  const matches = [...state.participants]
    .filter((alias) => alias !== (state.profile && state.profile.alias))
    .filter((alias) => {
      const label = (state.participantLabels.get(alias) || alias).toLowerCase();
      return alias.startsWith(partial) || label.startsWith(partial);
    })
    .slice(0, 5);
  if (matches.length === 0) {
    hideAutocomplete();
    return;
  }
  mentionAutocomplete.replaceChildren();
  matches.forEach((alias, index) => {
    const kind = state.participantKinds.get(alias) || "human";
    const option = document.createElement("li");
    option.className = "ac-option";
    option.dataset.alias = alias;
    if (index === 0) option.classList.add("sel");
    const avatar = document.createElement("span");
    avatar.className = `ac-avatar ${kind === "agent" ? "agent" : "human"}`;
    avatar.textContent = initialsFor(state.participantLabels.get(alias) || alias);
    const name = document.createElement("span");
    name.className = "ac-name";
    name.textContent = state.participantLabels.get(alias) || alias;
    const meta = document.createElement("span");
    meta.className = "ac-meta";
    meta.textContent = `${kind}${state.participantHosts.get(alias) ? " · host" : ""}`;
    option.append(avatar, name, meta);
    option.addEventListener("mousedown", (event) => {
      event.preventDefault();
      applyMention(alias);
    });
    mentionAutocomplete.append(option);
  });
  mentionAutocomplete.hidden = false;
}

function hideAutocomplete() {
  mentionAutocomplete.hidden = true;
  mentionAutocomplete.replaceChildren();
}

// Complete the active @token at the caret with the chosen alias.
function applyMention(alias) {
  if (!alias) return;
  const caret = messageText.selectionStart ?? messageText.value.length;
  const before = messageText.value.slice(0, caret);
  const after = messageText.value.slice(caret);
  const replaced = before.replace(/(^|[^\w-])@([a-z0-9-]*)$/, (_match, lead) => `${lead}@${alias} `);
  messageText.value = replaced + after;
  const nextCaret = replaced.length;
  messageText.setSelectionRange(nextCaret, nextCaret);
  messageText.focus();
  hideAutocomplete();
  updateMentionWarning();
  autoGrowComposer();
}

// ---- first-join → attending presence flips (#74) ----
function updateJoinFlips() {
  for (const flip of timeline.querySelectorAll(".joinflip")) {
    flip.hidden = !state.attending.has(flip.dataset.alias);
  }
}

// ---- route + quota connection state (#83/#84) ----
function markConnectionLive() {
  if (state.connection !== "live") setConnection("live");
}

const CONNECTION_ERROR_CODES = new Set([
  "quota_exceeded",
  "host_unavailable",
  "route_expired",
  "route_closed",
  "route_not_found"
]);

// A failed request reflects the route/quota only for these codes or for a bare
// transport failure (no code); everything else is an ordinary request error.
function isConnectionError(error) {
  const code = error && error.code;
  return code === undefined || code === null || CONNECTION_ERROR_CODES.has(code);
}

function handlePollError(error) {
  const code = error && error.code;
  if (code === "quota_exceeded") {
    setConnection("quota");
    return;
  }
  if (code === "route_closed" || code === "route_not_found") {
    state.roomStatus = "closed";
    applyRoomState();
    return;
  }
  // host_unavailable, route_expired, or a transport failure are all recoverable:
  // the route may come back, so show a degraded "reconnecting" banner.
  setConnection("degraded", code);
}

function setConnection(kind, code) {
  state.connection = kind;
  state.connectionCode = code || null;
  applyRoomState();
}

// Single place that reconciles the composer, banner, and history strip from the
// room lifecycle (open/closed) and the route connection (live/degraded/quota).
function applyRoomState() {
  const closed = state.roomStatus === "closed";
  shell.dataset.state = closed ? "closed" : "open";
  composer.hidden = closed;
  setComposerDisabled(closed || state.sendInFlight);
  renderBanner(closed);
  renderHistoryStrip(closed);
}

function renderBanner(closed) {
  if (closed || state.connection === "live") {
    roomBanner.hidden = true;
    return;
  }
  if (state.connection === "degraded") {
    roomBanner.dataset.kind = "degraded";
    bannerTitle.textContent = "Reconnecting…";
    const reason = state.connectionCode ? ` (${state.connectionCode})` : "";
    bannerDetail.textContent = `the host tunnel isn't responding${reason}. Messages will send once the route recovers.`;
    bannerAction.hidden = true;
  } else if (state.connection === "quota") {
    roomBanner.dataset.kind = "quota";
    bannerTitle.textContent = "Public route paused";
    bannerDetail.textContent = "free routing quota reached for this window — local-only rooms keep working; only public routing is metered.";
    bannerAction.textContent = "upgrade";
    bannerAction.href = "https://agentgather.dev";
    bannerAction.target = "_blank";
    bannerAction.rel = "noreferrer";
    bannerAction.hidden = false;
  }
  roomBanner.hidden = false;
}

// Closed-room history must name its real source (#83): the host log is still
// served read-only after close, so show that when reachable, and only fall back
// to an explicit "unavailable" when no source can be loaded. The participant
// room keeps no browser cache or export marker, so it never claims either.
function renderHistoryStrip(closed) {
  if (!closed) {
    historyStrip.hidden = true;
    historyKv.textContent = state.connection === "degraded" ? "reconnecting…" : "host live room";
    return;
  }
  const room = roomTitle.textContent || "room";
  const count = state.seen.size;
  if (state.historyAvailable) {
    historyKv.textContent = "host room · read-only";
    historySourceTag.textContent = "history source · host room (read-only)";
    historySourceNote.textContent = "— room is closed; showing the host's read-only history.";
    if (count > 0) {
      historySummary.textContent = `${room} · closed · ${count} ${count === 1 ? "message" : "messages"} · read-only`;
      historySummary.hidden = false;
    } else {
      historySummary.hidden = true;
    }
    historyFootNote.textContent = "no composer · export the transcript before you leave";
  } else {
    historyKv.textContent = "unavailable";
    historySourceTag.textContent = "history source · unavailable";
    historySourceNote.textContent = "— room is closed; live, cached & exported history are unavailable here.";
    historySummary.hidden = true;
    historyFootNote.textContent = "no composer";
  }
  historyStrip.hidden = false;
  emptyState.hidden = true;
}


function autoGrowComposer() {
  messageText.style.height = "auto";
  messageText.style.height = `${Math.min(messageText.scrollHeight, 144)}px`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatAgo(value) {
  const deltaSeconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (deltaSeconds < 60) return "just now";
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function formatRelative(value) {
  return `last seen ${formatAgo(value)}`;
}

function initialsFor(value) {
  const normalized = value.replace(/^@/, "").trim();
  const parts = normalized.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return normalized.slice(0, 2).toUpperCase() || "AG";
}

function showError(message) {
  authError.hidden = false;
  authError.querySelector("p").textContent = message;
  shell.dataset.state = "error";
}
