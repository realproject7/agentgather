const state = {
  token: null,
  cursor: 0,
  seen: new Set(),
  participants: new Set(),
  participantLabels: new Map(),
  participantKinds: new Map(),
  profile: null,
  roomStatus: "open",
  briefVersion: 0,
  replyTo: null,
  composing: false,
  sendInFlight: false,
  pendingSend: null
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
  });
  messageText.addEventListener("compositionstart", () => {
    state.composing = true;
  });
  messageText.addEventListener("compositionend", () => {
    state.composing = false;
  });
  messageText.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !state.composing) {
      event.preventDefault();
      void submitMessage();
    }
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitMessage();
  });
  closeButton.addEventListener("click", () => void closeRoom());
  exportButton.addEventListener("click", exportRoom);
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
  renderSafeMarkdown(briefBody, body);
}

async function loadStatus() {
  const payload = await authFetch("/status");
  state.roomStatus = payload.room_status;
  shell.dataset.state = payload.room_status;
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
  participantCount.textContent = `${payload.participants.length} participants`;
  renderParticipants(payload.participants);
  closeButton.hidden = !payload.is_host;
  exportButton.hidden = !payload.is_host;
  const closed = payload.room_status === "closed";
  setComposerDisabled(closed || state.sendInFlight);
}

async function pollMessages() {
  if (state.roomStatus === "closed") return;
  const payload = await authFetch(`/messages?since_id=${state.cursor}`);
  for (const message of payload.messages) {
    if (state.seen.has(message.id)) continue;
    state.seen.add(message.id);
    renderMessage(message);
  }
  state.cursor = payload.next_since_id;
  emptyState.hidden = state.seen.size > 0;
}

async function submitMessage() {
  if (state.sendInFlight) return;
  const text = messageText.value.trim();
  if (!text) return;
  sendError.hidden = true;
  const unknownMentions = findUnknownMentions(text);
  if (unknownMentions.length > 0) {
    sendError.hidden = false;
    sendError.textContent = `${unknownMentions.map((alias) => `@${alias}`).join(", ")} not in this room; not delivered as a mention.`;
  }
  const pending = ensurePendingSend(text, state.replyTo);
  const body = { text, client_msg_id: pending.clientMsgId };
  if (pending.replyTo !== null) body.reply_to = pending.replyTo;
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
    return;
  }
  messageText.value = "";
  state.replyTo = null;
  state.pendingSend = null;
  state.sendInFlight = false;
  setComposerDisabled(state.roomStatus === "closed");
  replyIndicator.hidden = true;
  autoGrowComposer();
  if (payload.message && !state.seen.has(payload.message.id)) {
    state.seen.add(payload.message.id);
    renderMessage(payload.message);
    state.cursor = Math.max(state.cursor, payload.message.id);
    emptyState.hidden = true;
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
  if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
  return payload;
}

function renderParticipants(participants) {
  participantList.replaceChildren();
  for (const participant of participants) {
    const item = document.createElement("li");
    item.className = "participant";
    item.dataset.attendanceState = participant.attendance_state || participant.attention;
    item.dataset.kind = participant.kind;
    item.dataset.host = participant.is_host ? "true" : "false";
    const name = document.createElement("strong");
    name.textContent = participant.display_name || participant.alias;
    const status = document.createElement("span");
    status.className = "participant-status";
    status.textContent = participantStatusText(participant);
    const meta = document.createElement("span");
    const alias = participant.display_name ? `@${participant.alias} · ` : "";
    meta.textContent = `${alias}${participant.kind} · ${participant.location} · ${participant.install} · ${participant.attendance_state || participant.attention} · ${formatRelative(participant.lastSeenAt)}`;
    item.append(name, status, meta);
    participantList.append(item);
  }
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
    renderSafeMarkdown(text, message.text, { compact: true });
    pill.append(time, text);
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
  renderSafeMarkdown(text, message.text);

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.append(from, time);

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

function renderSafeMarkdown(parent, markdown, options = {}) {
  parent.replaceChildren();
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  if (options.compact) {
    appendInlineMarkdown(parent, lines.map(stripMarkdownBlockPrefix).join(" "));
    return;
  }
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.trim() === "") {
      cursor += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const codeLines = [];
      cursor += 1;
      while (cursor < lines.length && !lines[cursor].startsWith("```")) {
        codeLines.push(lines[cursor]);
        cursor += 1;
      }
      if (cursor < lines.length) cursor += 1;
      appendCodeBlock(parent, codeLines.join("\n"));
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const element = document.createElement(`h${Math.min(heading[1].length, 3)}`);
      appendInlineMarkdown(element, heading[2]);
      parent.append(element);
      cursor += 1;
      continue;
    }
    if (/^\s*([-*_]\s*){3,}$/.test(line)) {
      parent.append(document.createElement("hr"));
      cursor += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (cursor < lines.length && /^>\s?/.test(lines[cursor])) {
        quoteLines.push(lines[cursor].replace(/^>\s?/, ""));
        cursor += 1;
      }
      const blockquote = document.createElement("blockquote");
      appendInlineMarkdown(blockquote, quoteLines.join("\n"));
      parent.append(blockquote);
      continue;
    }
    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const list = document.createElement(ordered ? "ol" : "ul");
      const pattern = ordered ? /^\d+\.\s+(.+)$/ : /^[-*]\s+(.+)$/;
      while (cursor < lines.length) {
        const match = pattern.exec(lines[cursor]);
        if (!match) break;
        const item = document.createElement("li");
        appendInlineMarkdown(item, match[1]);
        list.append(item);
        cursor += 1;
      }
      parent.append(list);
      continue;
    }
    const paragraphLines = [];
    while (cursor < lines.length && lines[cursor].trim() !== "" && !isMarkdownBlockStart(lines[cursor])) {
      paragraphLines.push(lines[cursor]);
      cursor += 1;
    }
    if (options.compact) {
      appendInlineMarkdown(parent, paragraphLines.join(" "));
    } else {
      const paragraph = document.createElement("p");
      appendInlineMarkdown(paragraph, paragraphLines.join("\n"));
      parent.append(paragraph);
    }
  }
}

function isMarkdownBlockStart(line) {
  return (
    line.startsWith("```") ||
    /^(#{1,3})\s+/.test(line) ||
    /^\s*([-*_]\s*){3,}$/.test(line) ||
    /^>\s?/.test(line) ||
    /^[-*]\s+/.test(line) ||
    /^\d+\.\s+/.test(line)
  );
}

function stripMarkdownBlockPrefix(line) {
  return line
    .replace(/^#{1,3}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();
}

function appendCodeBlock(parent, text) {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = text.trim();
  pre.append(code);
  parent.append(pre);
}

function appendInlineMarkdown(parent, text) {
  const tokenPattern = /(\*\*[^*\n][\s\S]*?\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^) \n]+?\)|https?:\/\/[^\s<]+|mailto:[^\s<]+|@[a-z0-9-]+)/gi;
  let cursor = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const value = match[0];
    const index = match.index || 0;
    appendText(parent, text.slice(cursor, index));
    if (value.startsWith("**") && value.endsWith("**")) {
      const strong = document.createElement("strong");
      appendInlineMarkdown(strong, value.slice(2, -2));
      parent.append(strong);
    } else if (value.startsWith("`") && value.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = value.slice(1, -1);
      parent.append(code);
    } else if (value.startsWith("[") && value.includes("](") && value.endsWith(")")) {
      appendMarkdownLink(parent, value);
    } else if (value.startsWith("@") && state.participants.has(value.slice(1))) {
      const mention = document.createElement("span");
      mention.className = "mention";
      mention.textContent = value;
      parent.append(mention);
    } else if (isSafeHref(value)) {
      const link = document.createElement("a");
      link.href = value;
      link.rel = "noreferrer";
      link.target = "_blank";
      link.textContent = value;
      parent.append(link);
    } else {
      appendText(parent, value);
    }
    cursor = index + value.length;
  }
  appendText(parent, text.slice(cursor));
}

function appendMarkdownLink(parent, value) {
  const match = /^\[([^\]\n]+)\]\(([^) \n]+)\)$/.exec(value);
  if (!match || !isSafeHref(match[2])) {
    appendText(parent, match ? match[1] : value);
    return;
  }
  const link = document.createElement("a");
  link.href = match[2];
  link.rel = "noreferrer";
  link.target = "_blank";
  link.textContent = match[1];
  parent.append(link);
}

function appendText(parent, text) {
  if (text) parent.append(document.createTextNode(text));
}

function summarizeBrief(body) {
  const candidate =
    body
      .split(/\r?\n/)
      .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").trim())
      .find((line) => line.length > 0) || "(empty)";
  return candidate.replace(/\*\*|`|\[|\]\([^)]+\)/g, "");
}

function findUnknownMentions(text) {
  const found = [];
  const seen = new Set();
  for (const match of text.matchAll(/(^|[^\w-])@([a-z0-9-]+)/g)) {
    const alias = match[2];
    if (!alias || state.participants.has(alias) || seen.has(alias)) continue;
    seen.add(alias);
    found.push(alias);
  }
  return found;
}

function isSafeHref(value) {
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
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

function formatRelative(value) {
  const deltaSeconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (deltaSeconds < 60) return "last seen now";
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `last seen ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `last seen ${hours}h ago`;
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
