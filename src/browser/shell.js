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
  pollTimer: null
};

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

init().catch((error) => showRoomsError(error instanceof Error ? error.message : String(error)));

async function init() {
  roomsToggle.addEventListener("click", () => shell.classList.toggle("rooms-open"));
  exportButton.addEventListener("click", exportTranscript);
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
  timeline.replaceChildren();
  shell.classList.remove("rooms-open");
  renderRoomList();
  const room = state.rooms.find((entry) => entry.room_id === roomId);
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

async function loadChat() {
  if (state.activeRoomId === null) return;
  let payload;
  try {
    payload = await apiFetch(`./rooms/${encodeURIComponent(state.activeRoomId)}/messages?since_id=${state.chatCursor}`);
  } catch {
    return;
  }
  if (payload.host_log_available === false) {
    chatOffline.hidden = false;
    chatOffline.textContent = "The host room log is not reachable from here. Open the room to view live messages.";
    chatEmpty.hidden = true;
    return;
  }
  chatOffline.hidden = true;
  for (const message of payload.messages || []) {
    if (state.seen.has(message.id)) continue;
    state.seen.add(message.id);
    renderMessage(message);
  }
  if (typeof payload.next_since_id === "number") state.chatCursor = payload.next_since_id;
  chatEmpty.hidden = state.seen.size > 0;
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
