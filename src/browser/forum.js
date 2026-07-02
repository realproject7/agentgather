// Forum channel UI (V2 #170). Renders the FROZEN T6 schema over the small forum
// HTTP surface (/forum/*) in two states: FEED (state A — flat post rows with
// search / New Post / sort / status filters) and THREAD (state B — focused view
// with breadcrumb, post body, chronological comments split by date dividers, and
// an anchored composer). Post-to-post navigation also nests under the forum
// channel in the shared channel rail.
//
// Reuses the shared safe Markdown renderer (no second renderer / no new
// injection surface). The wake-on-event badge is metadata only — derived from a
// participant's negotiated 9A effective_mode; it never drives any wake mechanic.
import { renderSafeMarkdown } from "./markdown.js";

const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
const fragmentToken = hashParams.get("token");
// Token: prefer the invite fragment, else this tab's sessionStorage copy, so a
// refresh or deep link keeps auth without leaving the token in the address bar.
// Mirrors the room surface (room.js, key "agentgather.token"). The token lives
// only in the fragment + tab-scoped sessionStorage — it is never written to the
// query string/history or persisted to host-owned room files (#172).
const token = fragmentToken || sessionStorage.getItem("agentgather.token");
if (token) sessionStorage.setItem("agentgather.token", token);
// Strip the token from the address bar once read (mirrors the room surface).
if (fragmentToken) history.replaceState(null, "", location.pathname + location.search);
const channel = new URLSearchParams(location.search).get("channel");

// Deep link (V2 #172): the selected forum post is addressable via a `post` query
// param alongside `channel`, so refresh / copy-link / direct handoff reopen the
// thread instead of falling back to the feed. The token is never written back
// here — it was stripped from the URL above and lives only in memory, so the
// synced address bar carries no bearer/participant token or invite URL.
function selectedPostParam() {
  return new URLSearchParams(location.search).get("post");
}

function syncSelectionUrl(postId) {
  const params = new URLSearchParams(location.search);
  if (postId === null || postId === undefined || postId === "") params.delete("post");
  else params.set("post", String(postId));
  const qs = params.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
}

const STATUSES = ["open", "answered", "resolved", "closed"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];
const state = {
  posts: [],
  filter: "all",
  query: "",
  sort: "newest",
  view: "feed",
  selected: null,
  participants: new Map()
};
// Nested-post rail hooks, handed over by channel-rail.js once the rail loads.
const rail = { subgroup: null, activeLink: null };

const el = (id) => document.getElementById(id);
const shell = document.querySelector(".forum-shell");

function authFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(path, { ...options, headers });
}

function relativeTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Calendar-day key + human label for grouping comments under date dividers.
function dayKey(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function initials(name) {
  return String(name || "?")
    .replace(/[^a-z0-9]/gi, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase() || "?";
}

function participantInfo(alias) {
  return state.participants.get(alias) || { kind: "agent", effective_mode: undefined };
}

function span(text) {
  const s = document.createElement("span");
  s.textContent = text;
  return s;
}

function spanClass(className, text) {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text;
  return s;
}

function statusPill(status) {
  const pill = document.createElement("span");
  pill.className = `st ${STATUSES.includes(status) ? status : "open"}`;
  const dot = document.createElement("span");
  dot.className = "d";
  dot.setAttribute("aria-hidden", "true");
  pill.append(dot, document.createTextNode(status));
  return pill;
}

function tagNodes(tags) {
  return (tags || []).map((tag) => spanClass("tag", tag));
}

function avatar(alias, kind) {
  const av = document.createElement("span");
  av.className = `av ${kind === "agent" ? "ag" : "hu"}`;
  av.textContent = initials(alias);
  return av;
}

function setListState(text, isError) {
  const node = el("list-state");
  if (text === null) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.textContent = text;
  node.classList.toggle("error", Boolean(isError));
}

// One-line body preview for a feed row (raw text — never rendered as markdown).
function bodyPreview(body) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function sortByDate(posts) {
  return posts.slice().sort((a, b) => {
    const ta = Date.parse(a.created_at) || 0;
    const tb = Date.parse(b.created_at) || 0;
    return state.sort === "newest" ? tb - ta : ta - tb;
  });
}

// ---- FEED (state A) ----
function visiblePosts() {
  let posts = state.posts;
  if (state.filter !== "all") posts = posts.filter((p) => p.status === state.filter);
  if (state.query) {
    posts = posts.filter((p) =>
      `${p.title} ${p.body} ${p.author}`.toLowerCase().includes(state.query)
    );
  }
  return sortByDate(posts);
}

function renderFeed() {
  const list = el("post-list");
  list.replaceChildren();
  if (state.posts.length === 0) {
    setListState("No posts yet. Start the first thread with “New Post”.");
    return;
  }
  const posts = visiblePosts();
  if (posts.length === 0) {
    setListState(state.query ? "No posts match your search." : `No ${state.filter} posts.`);
    return;
  }
  setListState(null);
  for (const post of posts) {
    const row = document.createElement("article");
    row.className = "row";
    row.dataset.id = post.id;
    row.tabIndex = 0;

    const col = document.createElement("div");
    col.className = "col";

    const title = spanClass("ti", post.title);

    const preview = document.createElement("div");
    preview.className = "pv";
    preview.append(spanClass("au", post.author), document.createTextNode(` · ${bodyPreview(post.body)}`));

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.append(statusPill(post.status));
    const tags = tagNodes(post.tags);
    if (tags.length > 0) {
      const tagWrap = document.createElement("span");
      tagWrap.className = "tags";
      tagWrap.append(...tags);
      meta.append(tagWrap);
    }
    const count = post.comment_count ?? 0;
    meta.append(spanClass("m cm", `▣ ${count} ${count === 1 ? "comment" : "comments"}`));
    meta.append(spanClass("m", relativeTime(post.created_at)));

    col.append(title, preview, meta);
    row.append(col);
    row.addEventListener("click", () => selectPost(post.id));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") selectPost(post.id);
    });
    list.append(row);
  }
}

// ---- THREAD (state B) ----
function renderThread(thread) {
  const { post, comments } = thread;
  // keep the cached count fresh so the feed/rail reflect it on return
  const idx = state.posts.findIndex((p) => p.id === post.id);
  if (idx >= 0) state.posts[idx].comment_count = comments.length;

  el("detail-state").hidden = true;
  el("detail").hidden = false;
  el("detail-title").textContent = post.title;
  el("crumb-title").textContent = post.title;

  const by = el("detail-by");
  by.replaceChildren();
  const info = participantInfo(post.author);
  by.append(avatar(post.author, info.kind));
  const name = document.createElement("span");
  if (info.kind === "agent") name.className = "agent";
  name.textContent = post.author;
  by.append(name, span(`· posted ${relativeTime(post.created_at)}`));
  if (post.updated_at && post.updated_at !== post.created_at) {
    by.append(span(`· updated ${relativeTime(post.updated_at)}`));
  }
  by.append(statusPill(post.status));

  el("detail-tags").replaceChildren(...tagNodes(post.tags));

  renderSafeMarkdown(el("detail-body"), post.body);

  const wrap = el("comments");
  wrap.replaceChildren();
  let lastDay = null;
  for (const comment of comments) {
    const day = dayKey(comment.created_at);
    if (day && day !== lastDay) {
      wrap.append(spanClass("datediv", dayLabel(comment.created_at)));
      lastDay = day;
    }
    wrap.append(renderComment(comment));
  }
}

function renderComment(comment) {
  const info = participantInfo(comment.author);
  const row = document.createElement("div");
  row.className = "cmt";
  row.append(avatar(comment.author, info.kind));
  const col = document.createElement("div");
  col.className = "col";
  const head = document.createElement("div");
  head.className = "ch1";
  const nm = document.createElement("span");
  nm.className = `nm${info.kind === "agent" ? " agent" : ""}`;
  nm.textContent = comment.author;
  head.append(
    nm,
    spanClass("ci", `· ${info.kind === "agent" ? "agent" : "human"}`),
    spanClass("tm", `· ${relativeTime(comment.created_at)}`)
  );
  // Metadata-only badge: this author attends via wake-on-event (9A). Display only.
  if (info.kind === "agent" && info.effective_mode === "wake_on_event") {
    head.append(spanClass("wakebadge", "↯ via wake-on-event"));
  }
  const body = document.createElement("div");
  body.className = "md";
  renderSafeMarkdown(body, comment.body);
  col.append(head, body);
  row.append(col);
  return row;
}

// ---- channel-rail nested posts (state A/B navigation) ----
function renderRailPosts() {
  if (!rail.subgroup) return;
  rail.subgroup.replaceChildren();
  if (state.posts.length === 0) {
    rail.subgroup.hidden = true;
    return;
  }
  for (const post of sortByDate(state.posts)) {
    const item = document.createElement("div");
    item.className = `rail-post${post.id === state.selected ? " on" : ""}`;
    item.dataset.id = post.id;
    item.tabIndex = 0;
    const pd = spanClass("pd", "◆");
    pd.setAttribute("aria-hidden", "true");
    item.append(pd, spanClass("nm", post.title));
    item.addEventListener("click", () => selectPost(post.id));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter") selectPost(post.id);
    });
    rail.subgroup.append(item);
  }
  rail.subgroup.hidden = false;
}

// Reflect the current state on the rail: in the feed the forum channel stays
// highlighted; in a thread the highlight moves down to the selected post.
function setRailActive() {
  const inThread = state.view === "thread";
  if (rail.activeLink) {
    rail.activeLink.classList.toggle("parent", inThread);
    rail.activeLink.classList.toggle("on", !inThread);
  }
  if (rail.subgroup) {
    for (const item of rail.subgroup.querySelectorAll(".rail-post")) {
      item.classList.toggle("on", inThread && item.dataset.id === String(state.selected));
    }
  }
}

async function selectPost(id) {
  state.selected = id;
  state.view = "thread";
  shell.dataset.view = "thread";
  syncSelectionUrl(id);
  setRailActive();
  el("detail").hidden = true;
  el("detail-state").hidden = false;
  el("detail-state").textContent = "Loading thread…";
  el("detail-state").classList.remove("error");
  try {
    const res = await authFetch(`/forum/post?channel=${encodeURIComponent(channel)}&post=${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    renderThread(await res.json());
  } catch {
    el("detail").hidden = true;
    el("detail-state").hidden = false;
    el("detail-state").textContent = "Could not load this post.";
    el("detail-state").classList.add("error");
  }
}

function backToFeed() {
  state.selected = null;
  state.view = "feed";
  shell.dataset.view = "feed";
  syncSelectionUrl(null);
  setRailActive();
  renderFeed();
}

// On initial load, honor a deep-linked post: open the thread when the id maps to
// a real post in the loaded feed; otherwise fall back gracefully to the feed and
// drop the stale param so the address bar matches the visible view (#172).
function applyInitialSelection() {
  const postId = selectedPostParam();
  if (!postId) return;
  if (state.posts.some((p) => String(p.id) === String(postId))) {
    void selectPost(postId);
  } else {
    syncSelectionUrl(null);
  }
}

async function loadParticipants() {
  try {
    const res = await authFetch("/status");
    if (!res.ok) return;
    const data = await res.json();
    state.participants = new Map((data.participants || []).map((p) => [p.alias, p]));
  } catch {
    /* roster is best-effort; human/agent cue falls back to agent */
  }
}

async function loadPosts() {
  setListState("Loading posts…");
  try {
    const res = await authFetch(`/forum/posts?channel=${encodeURIComponent(channel)}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    // comment_count is a derived, response-only field on the list endpoint.
    state.posts = (data.posts || []).map((p) => ({ comment_count: 0, ...p }));
    renderFeed();
    renderRailPosts();
    setRailActive();
  } catch {
    setListState("Could not load the forum. Check the channel and try again.", true);
  }
}

async function submitComment(event) {
  event.preventDefault();
  const body = el("comment-text").value.trim();
  el("comment-error").textContent = "";
  if (body.length === 0 || state.selected === null) return;
  try {
    const res = await authFetch("/forum/comment", {
      method: "POST",
      body: JSON.stringify({ channel, post: state.selected, body })
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    el("comment-text").value = "";
    await selectPost(state.selected);
  } catch {
    el("comment-error").textContent = "Could not add the comment.";
  }
}

async function submitNewPost(event) {
  event.preventDefault();
  const title = el("new-post-title").value.trim();
  const body = el("new-post-body").value;
  const tags = el("new-post-tags").value.split(",").map((t) => t.trim()).filter(Boolean);
  const error = el("new-post-error");
  error.hidden = true;
  if (title.length === 0) {
    error.textContent = "Title is required.";
    error.hidden = false;
    return;
  }
  try {
    const res = await authFetch("/forum/posts", {
      method: "POST",
      body: JSON.stringify({ channel, title, body, tags })
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const created = await res.json();
    el("new-post-form").hidden = true;
    el("new-post-title").value = "";
    el("new-post-body").value = "";
    el("new-post-tags").value = "";
    await loadPosts();
    if (created.post) selectPost(created.post.id);
  } catch {
    error.textContent = "Could not create the post.";
    error.hidden = false;
  }
}

function wireFilters() {
  for (const chip of document.querySelectorAll(".fchip")) {
    chip.addEventListener("click", () => {
      state.filter = chip.dataset.filter;
      for (const other of document.querySelectorAll(".fchip")) other.classList.toggle("on", other === chip);
      renderFeed();
    });
  }
}

function onRailReady(detail) {
  rail.subgroup = detail.subgroup || null;
  rail.activeLink = detail.activeForumLink || null;
  renderRailPosts();
  setRailActive();
}

function start() {
  // Register the rail handover listener synchronously, before any await, so the
  // channel-rail:ready event (fired after its async /boardroom fetch) is caught.
  document.addEventListener("channel-rail:ready", (event) => onRailReady(event.detail || {}));
  const existing = document.getElementById("rail-subgroup");
  if (existing) onRailReady({ subgroup: existing, activeForumLink: document.getElementById("rail-active-forum") });

  el("forum-channel-title").textContent = channel ? `forum · #${channel}` : "forum";
  el("crumb-channel").textContent = `◆ ${channel || "forum"}`;
  wireFilters();
  el("comment-form").addEventListener("submit", submitComment);
  el("new-post-form").addEventListener("submit", submitNewPost);
  el("new-post").addEventListener("click", () => {
    el("new-post-form").hidden = !el("new-post-form").hidden;
  });
  el("new-post-cancel").addEventListener("click", () => {
    el("new-post-form").hidden = true;
  });
  el("forum-back").addEventListener("click", backToFeed);
  el("forum-search").addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderFeed();
  });
  el("sort-btn").addEventListener("click", () => {
    state.sort = state.sort === "newest" ? "oldest" : "newest";
    el("sort-label").textContent = state.sort;
    renderFeed();
    renderRailPosts();
    setRailActive();
  });
  if (!channel) {
    setListState("No forum channel selected. Add ?channel=<forum-channel> to the URL.", true);
    return;
  }
  void loadParticipants().then(loadPosts).then(applyInitialSelection);
}

start();
