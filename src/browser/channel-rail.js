// V2 Ticket B (#161): boardroom channel rail + shell routing.
//
// Renders the channel list from the metadata-only GET /boardroom (#160) and
// routes the main pane by selected channel: a `chat` channel opens the existing
// chat surface (room.html); a `forum` channel opens the existing forum surface
// (forum.html). The two surfaces are reused unchanged — this module only adds
// the rail + cross-surface navigation.
//
// No tokens are read from /boardroom (the payload is metadata-only). The
// session's own token rides the URL fragment to reach the forum surface — the
// same mechanism the forum surface already requires.
//
// A legacy / single-channel room renders exactly as today: the rail stays
// hidden, so the chat surface is visually unchanged (zero regression).
//
// V2 #167 (disable option): only the default #general chat channel carries chat
// in this version. Any other `chat`-type channel renders DISABLED in the rail
// (dimmed + "soon", not-allowed) and is NOT routed into the room-wide log;
// selecting it shows a clear not-active pane that points back to #general. Forum
// channels and #general stay fully usable.

// Mirrors DEFAULT_CHANNEL_ID in src/protocol/boardroom.ts — the legacy room log
// is surfaced as the #general chat channel; no other chat channel is backed yet.
const DEFAULT_CHANNEL_ID = "general";

const rail = document.getElementById("channel-rail");
if (rail) void initRail(rail);

async function initRail(railEl) {
  // Capture the token synchronously before the surface script strips the
  // fragment; fall back to the room surface's sessionStorage copy.
  const token = sessionToken();

  let boardroom;
  try {
    const res = await fetch("/boardroom", {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!res.ok) return; // pre-join / unauthenticated → render as today (no rail)
    boardroom = (await res.json()).boardroom;
  } catch {
    return; // network error → leave the surface unchanged
  }

  const channels = (boardroom && Array.isArray(boardroom.channels) ? boardroom.channels : []).filter(
    (channel) => channel && channel.lifecycle !== "removed"
  );
  // Only a real multi-channel boardroom gets a rail; a single-room/legacy room
  // is left exactly as today.
  if (channels.length <= 1) return;

  const onForum = location.pathname.replace(/\/+$/, "").endsWith("forum.html");
  const activeForum = onForum ? new URLSearchParams(location.search).get("channel") : null;
  const frame = railEl.closest(".boardroom-frame");

  const list = document.createElement("ul");
  list.className = "rail-channels";
  // Empty container for the active forum channel's nested posts; the forum
  // surface (forum.js) fills it once its post list loads. The rail itself
  // stays metadata-only — it never fetches forum posts.
  let forumSubgroup = null;
  let activeForumLink = null;
  for (const channel of channels) {
    // A non-#general chat channel is not usable yet → render it disabled and
    // route its selection to the not-active pane instead of the room-wide log.
    if (channel.type === "chat" && channel.id !== DEFAULT_CHANNEL_ID) {
      list.append(disabledChatItem(channel, frame, token));
      continue;
    }
    // The functional chat channel is #general; it stays active on the room
    // surface, while the active forum channel is active on the forum surface.
    const active = onForum
      ? channel.type === "forum" && channel.id === activeForum
      : channel.type === "chat" && channel.id === DEFAULT_CHANNEL_ID;
    const isActiveForum = active && channel.type === "forum";
    const link = channelLink(channel, active, token, isActiveForum);
    list.append(link);
    // Nest forum posts as children of the active forum channel (indent + caret).
    if (isActiveForum) {
      activeForumLink = link;
      forumSubgroup = document.createElement("div");
      forumSubgroup.className = "rail-subgroup";
      forumSubgroup.id = "rail-subgroup";
      forumSubgroup.hidden = true;
      list.append(forumSubgroup);
    }
  }

  railEl.replaceChildren(railHead(boardroom), railGroup("channels"), list);
  railEl.hidden = false;

  // Hand the empty container + active link to the forum surface so it can
  // render the nested posts and drive their active state. The forum module
  // registers its listener synchronously at load, before this async fetch
  // resolves, so the event is never missed.
  if (forumSubgroup) {
    document.dispatchEvent(
      new CustomEvent("channel-rail:ready", {
        detail: { subgroup: forumSubgroup, activeForumLink, activeForumId: activeForum }
      })
    );
  }
}

function sessionToken() {
  const fragment = new URLSearchParams(location.hash.slice(1)).get("token");
  let stored = null;
  try {
    stored = sessionStorage.getItem("agentgather.token");
  } catch {
    stored = null;
  }
  return fragment || stored;
}

function railHead(boardroom) {
  const head = document.createElement("div");
  head.className = "rail-head";
  const mark = document.createElement("span");
  mark.className = "mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "◆";
  const room = document.createElement("span");
  room.className = "room";
  room.textContent = boardroom.name || boardroom.id;
  head.append(mark, room);
  return head;
}

function railGroup(label) {
  const group = document.createElement("div");
  group.className = "rail-group";
  group.textContent = label;
  return group;
}

function channelLink(channel, active, token, isActiveForum = false) {
  const link = document.createElement("a");
  link.className = active ? "channel-link on" : "channel-link";
  link.href = channelHref(channel, token);
  if (active) link.setAttribute("aria-current", "true");
  if (isActiveForum) link.id = "rail-active-forum";

  const glyph = document.createElement("span");
  glyph.className = "glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = channel.type === "forum" ? "◆" : "#";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = channel.name || channel.id;

  link.append(glyph, name);
  // The active forum channel carries a disclosure caret for its nested posts;
  // every other channel shows its type label.
  if (isActiveForum) {
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "▾";
    link.append(caret);
  } else {
    const type = document.createElement("span");
    type.className = "type";
    type.textContent = channel.type;
    link.append(type);
  }
  return link;
}

function spanCls(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

// A disabled (non-#general) chat channel: dimmed, a "soon" tag, not-allowed, and
// not a navigable link. Selecting it opens the not-active pane rather than
// routing into the room-wide log.
function disabledChatItem(channel, frame, token) {
  const item = document.createElement("div");
  item.className = "channel-link disabled";
  item.setAttribute("role", "button");
  item.tabIndex = 0;
  item.title = `Channel-scoped chat isn't available yet. Only #${DEFAULT_CHANNEL_ID} carries chat in this version.`;

  const glyph = spanCls("glyph", "#");
  glyph.setAttribute("aria-hidden", "true");
  item.append(glyph, spanCls("name", channel.name || channel.id), spanCls("soon", "soon"));

  const open = () => showNotActivePane(channel, frame, token);
  item.addEventListener("click", open);
  item.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
  return item;
}

// Replace the reused surface with a clear not-active pane (NOT the room-wide
// log). The rail stays; the pane carries a "Go to #general" action.
function showNotActivePane(channel, frame, token) {
  if (!frame) return;
  const surface = frame.querySelector(".room-shell, .forum-shell");
  if (surface) surface.style.display = "none";
  // Nothing in the rail is highlighted while a not-active channel is shown — the
  // disabled item stays dimmed, mirroring the OpenDesign.
  for (const link of frame.querySelectorAll(".channel-link.on")) {
    link.classList.remove("on");
    link.removeAttribute("aria-current");
  }
  let pane = frame.querySelector(".not-active-pane");
  if (!pane) {
    pane = buildNotActivePane(token);
    frame.append(pane);
  }
  pane.querySelector(".na-name").textContent = channel.name || channel.id;
  pane.hidden = false;
}

function buildNotActivePane(token) {
  const pane = document.createElement("section");
  pane.className = "not-active-pane";

  const bar = document.createElement("div");
  bar.className = "na-bar";
  const title = document.createElement("span");
  title.className = "na-title";
  const hash = spanCls("h", "#");
  hash.setAttribute("aria-hidden", "true");
  title.append(hash, spanCls("na-name", ""));
  bar.append(title, spanCls("na-tag", "not active"));

  const body = document.createElement("div");
  body.className = "notactive";
  const icon = spanCls("na-ic", "#");
  icon.setAttribute("aria-hidden", "true");
  const heading = spanCls("na-t", "This chat channel isn’t active yet");
  const detail = document.createElement("div");
  detail.className = "na-d";
  const general = document.createElement("b");
  general.textContent = "#general";
  detail.append(
    document.createTextNode("Only "),
    general,
    document.createTextNode(
      " carries chat in this version. Channel-scoped chat for additional chat channels is planned but not implemented — so this channel is shown but not usable, instead of routing you into the room-wide log. Forum channels are fully usable."
    )
  );
  const go = document.createElement("button");
  go.type = "button";
  go.className = "na-go";
  go.textContent = "Go to #general";
  go.addEventListener("click", () => {
    location.href = `./${token ? `#token=${encodeURIComponent(token)}` : ""}`;
  });

  body.append(icon, heading, detail, go);
  pane.append(bar, body);
  return pane;
}

// chat channel → the room surface; forum channel → the forum surface. The
// session token rides the fragment so the target surface can authenticate.
function channelHref(channel, token) {
  const fragment = token ? `#token=${encodeURIComponent(token)}` : "";
  if (channel.type === "forum") {
    return `forum.html?channel=${encodeURIComponent(channel.id)}${fragment}`;
  }
  return `./${fragment}`;
}
