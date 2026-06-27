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
  const firstChat = channels.find((channel) => channel.type === "chat");

  const list = document.createElement("ul");
  list.className = "rail-channels";
  for (const channel of channels) {
    const active = onForum
      ? channel.type === "forum" && channel.id === activeForum
      : channel.type === "chat" && firstChat !== undefined && channel.id === firstChat.id;
    list.append(channelLink(channel, active, token));
  }

  railEl.replaceChildren(railHead(boardroom), railGroup("channels"), list);
  railEl.hidden = false;
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

function channelLink(channel, active, token) {
  const link = document.createElement("a");
  link.className = active ? "channel-link on" : "channel-link";
  link.href = channelHref(channel, token);
  if (active) link.setAttribute("aria-current", "true");

  const glyph = document.createElement("span");
  glyph.className = "glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = channel.type === "forum" ? "◆" : "#";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = channel.name || channel.id;

  const type = document.createElement("span");
  type.className = "type";
  type.textContent = channel.type;

  link.append(glyph, name, type);
  return link;
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
