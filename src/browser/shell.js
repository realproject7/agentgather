// Owner platform shell.
//
// Consumes the control-plane API (#80/#81) for the room list and per-room
// status/health/roster, and reads live host-owned messages for the active room
// from the platform's read-only chat endpoint. It never derives status or stores
// messages itself; it only renders what the platform serves.

const state = {
  rooms: [],
  activeRoomId: null,
  chatCursor: 0,
  seen: new Set(),
  messages: [],
  cacheRendered: false,
  pollTimer: null
};

// Browser-local, per-room cache namespaces. Stores only already-received,
// non-secret message fields — never bearer tokens or invite URLs.
const HISTORY_PREFIX = "agentgather.history.";
const EXPORT_PREFIX = "agentgather.exported.";

const shell = document.querySelector(".platform-shell");
const ownerLabel = document.getElementById("owner-label");
const roomsToggle = document.getElementById("rooms-toggle");
const roomList = document.getElementById("room-list");
const roomsEmpty = document.getElementById("rooms-empty");
const roomsError = document.getElementById("rooms-error");
const detailEmpty = document.getElementById("detail-empty");
const detail = document.getElementById("detail");
const detailTitle = document.getElementById("detail-title");
const detailStatus = document.getElementById("detail-status");
const detailReason = document.getElementById("detail-reason");
const routeReachable = document.getElementById("route-reachable");
const routeHost = document.getElementById("route-host");
const exportButton = document.getElementById("export-button");
const openRoom = document.getElementById("open-room");
const routeVisibility = document.getElementById("route-visibility");
const chatOffline = document.getElementById("chat-offline");
const chatEmpty = document.getElementById("chat-empty");
const timeline = document.getElementById("shell-timeline");
const roster = document.getElementById("shell-roster");
const clearCacheButton = document.getElementById("clear-cache-button");
const historySource = document.getElementById("history-source");
const historySourceLabel = document.getElementById("history-source-label");

init().catch((error) => showRoomsError(error instanceof Error ? error.message : String(error)));

async function init() {
  roomsToggle.addEventListener("click", () => shell.classList.toggle("rooms-open"));
  exportButton.addEventListener("click", exportTranscript);
  clearCacheButton.addEventListener("click", clearActiveCache);
  await loadRooms();
  shell.dataset.state = "ready";
  setInterval(() => void loadRooms(), 5000);
}

async function loadRooms() {
  let payload;
  try {
    payload = await apiFetch("./rooms");
  } catch (error) {
    showRoomsError(error instanceof Error ? error.message : String(error));
    return;
  }
  roomsError.hidden = true;
  state.rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
  ownerLabel.textContent = state.rooms[0]?.owner_user_id || "owner";
  renderRoomList();
  if (state.activeRoomId !== null) {
    const active = state.rooms.find((room) => room.room_id === state.activeRoomId);
    if (active) renderDetail(active);
  }
}

function renderRoomList() {
  roomList.replaceChildren();
  roomsEmpty.hidden = state.rooms.length > 0;
  for (const room of state.rooms) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "room-row";
    button.dataset.roomId = room.room_id;
    button.dataset.status = room.status;
    if (room.room_id === state.activeRoomId) button.setAttribute("aria-current", "true");

    const title = document.createElement("span");
    title.className = "room-row-title";
    title.textContent = room.title || room.room_id;

    const badge = document.createElement("span");
    badge.className = "status-badge";
    badge.dataset.status = room.status;
    badge.textContent = room.status;

    button.append(title, badge);
    button.addEventListener("click", () => void selectRoom(room.room_id));
    item.append(button);
    roomList.append(item);
  }
}

async function selectRoom(roomId) {
  state.activeRoomId = roomId;
  state.chatCursor = 0;
  state.seen = new Set();
  state.messages = [];
  state.cacheRendered = false;
  timeline.replaceChildren();
  shell.classList.remove("rooms-open");
  renderRoomList();
  const room = state.rooms.find((entry) => entry.room_id === roomId);
  // Provisionally show this browser's cached copy until live availability is
  // known. These entries are not added to seen/messages, so a live fetch
  // replaces them with the faithful host copy rather than being skipped.
  const cached = readCache(roomId);
  for (const message of cached) renderMessage(message);
  state.cacheRendered = cached.length > 0;
  if (room) renderDetail(room);
  if (state.pollTimer !== null) clearInterval(state.pollTimer);
  await loadChat();
  state.pollTimer = setInterval(() => void loadChat(), 3000);
}

function renderDetail(room) {
  detailEmpty.hidden = true;
  detail.hidden = false;
  detailTitle.textContent = room.title || room.room_id;
  detailStatus.textContent = room.status;
  detailStatus.dataset.status = room.status;
  detailReason.textContent = room.status_reason ? `reason: ${room.status_reason}` : "";
  const health = room.route_health || { reachable: false, host_connected: false };
  routeReachable.dataset.on = String(Boolean(health.reachable));
  routeReachable.textContent = health.reachable ? "route reachable" : "route unreachable";
  routeHost.dataset.on = String(Boolean(health.host_connected));
  routeHost.textContent = health.host_connected ? "host connected" : "host offline";
  if (room.route_url) {
    openRoom.href = room.route_url;
    openRoom.hidden = false;
    routeVisibility.textContent = room.route_url;
  } else {
    openRoom.removeAttribute("href");
    openRoom.hidden = true;
    routeVisibility.textContent = "no route published";
  }
  renderRoster(Array.isArray(room.roster) ? room.roster : []);
}

function renderRoster(entries) {
  roster.replaceChildren();
  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = "roster-entry";
    item.dataset.kind = entry.kind;

    const name = document.createElement("div");
    name.className = "roster-name";
    name.textContent = entry.alias;

    const kind = document.createElement("span");
    kind.className = "roster-kind";
    kind.textContent = entry.kind === "human" ? "Human" : entry.kind === "agent" ? "Agent" : entry.kind;

    const meta = document.createElement("div");
    meta.className = "roster-meta";
    meta.textContent = `${entry.role} · ${entry.status}`;

    item.append(name, kind, meta);
    roster.append(item);
  }
}

// Source precedence: live host -> browser-local cache -> exported summary label
// -> empty/offline. Live vs unavailable is decided by the #81 status the shell
// already holds (active/idle = reachable host) plus the host-log availability.
async function loadChat() {
  if (state.activeRoomId === null) return;
  const room = state.rooms.find((entry) => entry.room_id === state.activeRoomId);

  // A closed room clears this browser's local copy (shared-browser safety).
  if (room !== undefined && room.status === "closed") {
    clearCache(state.activeRoomId);
    state.messages = [];
    state.seen = new Set();
    state.cacheRendered = false;
    timeline.replaceChildren();
    updateHistorySource("empty", room);
    return;
  }

  let payload = null;
  try {
    payload = await apiFetch(`./rooms/${encodeURIComponent(state.activeRoomId)}/messages?since_id=${state.chatCursor}`);
  } catch {
    payload = null;
  }
  const hostLive =
    payload !== null &&
    payload.host_log_available !== false &&
    room !== undefined &&
    (room.status === "active" || room.status === "idle");

  if (hostLive) {
    // Replace any provisional (redacted) cache render with the faithful live
    // payload, which on first load returns the full history from since_id=0.
    if (state.cacheRendered) {
      timeline.replaceChildren();
      state.seen = new Set();
      state.messages = [];
      state.cacheRendered = false;
    }
    for (const message of payload.messages || []) {
      if (state.seen.has(message.id)) continue;
      state.seen.add(message.id);
      state.messages.push(message);
      renderMessage(message);
    }
    if (typeof payload.next_since_id === "number") state.chatCursor = payload.next_since_id;
    writeCache(state.activeRoomId, state.messages);
    updateHistorySource("live", room);
    return;
  }

  // Host not live: fall through cache -> exported summary label -> empty.
  if (state.cacheRendered || state.messages.length > 0) {
    updateHistorySource("cache", room);
  } else if (exportedAt(state.activeRoomId) !== null) {
    updateHistorySource("exported", room);
  } else {
    updateHistorySource("empty", room);
  }
}

function updateHistorySource(source, room) {
  historySource.dataset.source = source;
  if (source === "live") {
    historySourceLabel.textContent = "History: live host room";
    chatOffline.hidden = true;
    chatEmpty.hidden = state.messages.length > 0;
    return;
  }
  if (source === "cache") {
    historySourceLabel.textContent = "History: local cache (host offline)";
    chatOffline.hidden = false;
    chatOffline.textContent =
      pausedCopy(room) ||
      "Host is offline. Showing messages cached in this browser; live updates resume when the host is reachable.";
    chatEmpty.hidden = true;
    return;
  }
  if (source === "exported") {
    historySourceLabel.textContent = "History: exported summary";
    chatOffline.hidden = false;
    chatOffline.textContent = `${pausedCopy(room) || "Host is offline with no cached messages."} An exported summary is saved for this room in this browser.`;
    chatEmpty.hidden = true;
    return;
  }
  historySourceLabel.textContent = "History: none";
  chatOffline.hidden = false;
  chatOffline.textContent = pausedCopy(room) || "Host is offline and no messages are cached in this browser yet.";
  chatEmpty.hidden = true;
}

// Paused/offline copy comes from the #81 platform status/reason, never a generic
// network error.
function pausedCopy(room) {
  if (room === undefined) return "";
  const reason = room.status_reason ? ` (${room.status_reason})` : "";
  if (room.status === "paused") return `This room is paused${reason}. The host must reopen this room.`;
  if (room.status === "closed") return `This room is closed${reason}.`;
  return "";
}

function renderMessage(message) {
  const item = document.createElement("li");
  item.className = `shell-message ${message.type === "system" ? "system" : ""}`.trim();

  const from = document.createElement("span");
  from.className = "shell-message-from";
  from.textContent = message.from;

  const time = document.createElement("time");
  time.className = "shell-message-time";
  time.dateTime = message.ts;
  time.textContent = formatTime(message.ts);

  const meta = document.createElement("div");
  meta.className = "shell-message-meta";
  meta.append(from, time);

  const text = document.createElement("div");
  text.className = "shell-message-text";
  text.textContent = message.text;

  item.append(meta, text);
  timeline.append(item);
  item.scrollIntoView({ block: "nearest" });
}

function exportTranscript() {
  const rows = [...timeline.querySelectorAll(".shell-message")].map((row) => row.textContent.trim());
  const blob = new Blob([rows.join("\n\n")], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `agentgather-${state.activeRoomId || "room"}.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
  if (state.activeRoomId !== null) markExported(state.activeRoomId);
}

function clearActiveCache() {
  if (state.activeRoomId === null) return;
  clearCache(state.activeRoomId);
  state.messages = [];
  state.seen = new Set();
  state.chatCursor = 0;
  state.cacheRendered = false;
  timeline.replaceChildren();
  updateHistorySource("empty", state.rooms.find((entry) => entry.room_id === state.activeRoomId));
}

function readCache(roomId) {
  try {
    const raw = window.localStorage.getItem(HISTORY_PREFIX + roomId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch {
    return [];
  }
}

// Redact secrets that can appear inside a message body before it is persisted.
// Live rendering stays faithful; only the cached copy is sanitized so a shared
// browser's localStorage never holds a bearer token or a tokenized invite/card
// URL. Strips the literal "Bearer", "token=", "#token=", and "tgl_" forms.
function redactForCache(text) {
  return String(text)
    // Drop the entire invite/card or tokenized URL, not just the token value, so
    // no invite-card URL shape survives in the cache.
    .replace(/https?:\/\/(?=\S*(?:token=|tgl_|\/card))\S+/gi, "[redacted-url]")
    .replace(/Bearer\s+\S+/gi, "[redacted-credential]")
    .replace(/[#?&]?token=[^\s&#"']+/gi, "[redacted-token]")
    .replace(/tgl_[A-Za-z0-9_-]+/g, "[redacted-token]");
}

function writeCache(roomId, messages) {
  // Persist only already-received, non-secret fields, scoped to this room, with
  // secrets inside the message body redacted.
  const safe = messages.map((message) => ({
    id: message.id,
    from: message.from,
    ts: message.ts,
    type: message.type,
    text: redactForCache(message.text)
  }));
  try {
    window.localStorage.setItem(
      HISTORY_PREFIX + roomId,
      JSON.stringify({ messages: safe, updated_at: new Date().toISOString() })
    );
  } catch {
    // Storage may be unavailable or full; the live view still works.
  }
}

function clearCache(roomId) {
  try {
    window.localStorage.removeItem(HISTORY_PREFIX + roomId);
    window.localStorage.removeItem(EXPORT_PREFIX + roomId);
  } catch {
    // Ignore storage errors on clear.
  }
}

function markExported(roomId) {
  try {
    window.localStorage.setItem(EXPORT_PREFIX + roomId, new Date().toISOString());
  } catch {
    // Ignore storage errors.
  }
}

function exportedAt(roomId) {
  try {
    return window.localStorage.getItem(EXPORT_PREFIX + roomId);
  } catch {
    return null;
  }
}

async function apiFetch(path) {
  const target = new URL(path.replace(/^\.\//, ""), document.baseURI);
  const response = await fetch(target, { headers: { Accept: "application/json" } });
  const body = await response.text();
  const payload = body ? JSON.parse(body) : {};
  if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
  return payload;
}

function showRoomsError(message) {
  roomsError.hidden = false;
  roomsError.textContent = message;
}

function formatTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(parsed);
}
