const state = {
  token: null,
  cursor: 0,
  seen: new Set(),
  participants: new Set(),
  roomStatus: "open",
  briefVersion: 0,
  replyTo: null,
  composing: false
};

const shell = document.querySelector(".room-shell");
const authError = document.getElementById("auth-error");
const roomTitle = document.getElementById("room-title");
const roomStatus = document.getElementById("room-status");
const participantCount = document.getElementById("participant-count");
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
  state.token = tokenFromFragment() || sessionStorage.getItem("telegent.token");
  if (!state.token) {
    authError.hidden = false;
    shell.dataset.state = "auth-error";
    return;
  }
  sessionStorage.setItem("telegent.token", state.token);
  await Promise.all([loadBrief(), loadStatus()]);
  await pollMessages();
  setInterval(() => void pollMessages(), 3000);
  setInterval(() => void loadStatus(), 5000);
  bindEvents();
}

function bindEvents() {
  rosterToggle.addEventListener("click", () => shell.classList.toggle("roster-open"));
  briefRefresh.addEventListener("click", () => void loadBrief());
  systemFilter.addEventListener("change", () => {
    timeline.classList.toggle("hide-system", !systemFilter.checked);
  });
  messageText.addEventListener("input", autoGrowComposer);
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
  briefBody.textContent = brief.body || "(empty)";
}

async function loadStatus() {
  const payload = await authFetch("/status");
  state.roomStatus = payload.room_status;
  shell.dataset.state = payload.room_status;
  roomTitle.textContent = payload.room;
  roomStatus.textContent = payload.room_status;
  roomStatus.dataset.status = payload.room_status;
  if (payload.brief_version > state.briefVersion) {
    briefRefresh.hidden = false;
    briefVersion.textContent = `v${payload.brief_version} available`;
  }
  state.participants = new Set(payload.participants.map((participant) => participant.alias));
  participantCount.textContent = `${payload.participants.length} participants`;
  renderParticipants(payload.participants);
  closeButton.hidden = !payload.is_host;
  exportButton.hidden = !payload.is_host;
  const closed = payload.room_status === "closed";
  messageText.disabled = closed;
  sendButton.disabled = closed;
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
  const text = messageText.value.trim();
  if (!text) return;
  sendError.hidden = true;
  const unknownMentions = findUnknownMentions(text);
  if (unknownMentions.length > 0) {
    sendError.hidden = false;
    sendError.textContent = `${unknownMentions.map((alias) => `@${alias}`).join(", ")} not in this room; not delivered as a mention.`;
  }
  const body = {
    text,
    client_msg_id: `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`
  };
  if (state.replyTo !== null) body.reply_to = state.replyTo;
  let payload;
  try {
    payload = await authFetch("/messages", {
      method: "POST",
      body: JSON.stringify(body)
    });
  } catch (error) {
    sendError.hidden = false;
    sendError.textContent = error instanceof Error ? error.message : String(error);
    return;
  }
  messageText.value = "";
  state.replyTo = null;
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
  link.download = "telegent-room.txt";
  link.click();
  URL.revokeObjectURL(link.href);
}

async function authFetch(path, options = {}) {
  const response = await fetch(path, {
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
    const name = document.createElement("strong");
    name.textContent = participant.alias;
    const meta = document.createElement("span");
    meta.textContent = `${participant.kind} · ${participant.location} · ${participant.install} · ${participant.attention} · ${formatRelative(participant.lastSeenAt)}`;
    item.append(name, meta);
    participantList.append(item);
  }
}

function renderMessage(message) {
  const item = document.createElement("li");
  item.className = `message ${message.type === "system" ? "system" : ""}`;
  item.dataset.messageId = String(message.id);

  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = message.ts;
  time.textContent = formatTime(message.ts);

  const from = document.createElement("div");
  from.className = "message-from";
  from.textContent = message.from;

  const text = document.createElement("div");
  text.className = "message-text";
  appendRichText(text, message.text);

  item.addEventListener("dblclick", () => setReply(message));
  item.append(time, from, text);
  timeline.append(item);
  item.scrollIntoView({ block: "nearest" });
}

function setReply(message) {
  state.replyTo = message.id;
  replyIndicator.hidden = false;
  replyIndicator.textContent = `Replying to ${message.from} #${message.id}`;
  messageText.focus();
}

function appendRichText(parent, text) {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("```") && part.endsWith("```")) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = part.slice(3, -3).trim();
      pre.append(code);
      parent.append(pre);
    } else if (part.startsWith("`") && part.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      parent.append(code);
    } else {
      appendTextWithTokens(parent, part);
    }
  }
}

function appendTextWithTokens(parent, text) {
  const tokenPattern = /(https?:\/\/[^\s<]+|mailto:[^\s<]+|@[a-z0-9-]+)/g;
  let cursor = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const value = match[0];
    const index = match.index || 0;
    appendText(parent, text.slice(cursor, index));
    if (value.startsWith("@") && state.participants.has(value.slice(1))) {
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

function appendText(parent, text) {
  if (text) parent.append(document.createTextNode(text));
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

function showError(message) {
  authError.hidden = false;
  authError.querySelector("p").textContent = message;
  shell.dataset.state = "error";
}
