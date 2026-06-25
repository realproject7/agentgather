// Forum channel UI (V2 T8). Renders the FROZEN T6 schema over the small forum
// HTTP surface (/forum/*). Reuses the shared safe Markdown renderer (no second
// renderer / no new injection surface). The wake-on-event badge is metadata
// only — derived from a participant's negotiated 9A effective_mode; it never
// drives any wake mechanic.
import { renderSafeMarkdown } from "./markdown.js";

const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
const token = hashParams.get("token");
// Strip the token from the address bar once read (mirrors the room surface).
if (token) history.replaceState(null, "", location.pathname + location.search);
const channel = new URLSearchParams(location.search).get("channel");

const STATUSES = ["open", "answered", "resolved", "closed"];
const state = { posts: [], filter: "all", selected: null, participants: new Map() };

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

function statusPill(status) {
  const pill = document.createElement("span");
  pill.className = `st ${STATUSES.includes(status) ? status : "open"}`;
  const dot = document.createElement("span");
  dot.className = "d";
  dot.setAttribute("aria-hidden", "true");
  pill.append(dot, document.createTextNode(status));
  return pill;
}

function tagList(tags) {
  const wrap = document.createElement("div");
  wrap.className = "tags";
  for (const tag of tags || []) {
    const span = document.createElement("span");
    span.className = "tag";
    span.textContent = tag;
    wrap.append(span);
  }
  return wrap;
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

function renderList() {
  const list = el("post-list");
  list.replaceChildren();
  const posts = state.filter === "all" ? state.posts : state.posts.filter((p) => p.status === state.filter);
  el("post-count").textContent = `${state.posts.length} ${state.posts.length === 1 ? "post" : "posts"}`;
  if (state.posts.length === 0) {
    setListState("No posts yet. Start the first thread with “new post”.");
    return;
  }
  if (posts.length === 0) {
    setListState(`No ${state.filter} posts.`);
    return;
  }
  setListState(null);
  for (const post of posts) {
    const item = document.createElement("li");
    item.className = `post${post.id === state.selected ? " sel" : ""}`;
    item.tabIndex = 0;
    const r1 = document.createElement("div");
    r1.className = "row";
    const title = document.createElement("span");
    title.className = "ti";
    title.textContent = post.title;
    r1.append(title);
    const r2 = document.createElement("div");
    r2.className = "row";
    r2.append(statusPill(post.status), tagList(post.tags));
    const meta = document.createElement("div");
    meta.className = "meta";
    const author = document.createElement("span");
    author.className = `a${participantInfo(post.author).kind === "agent" ? " agent" : ""}`;
    author.textContent = post.author;
    meta.append(author, span(`· ${relativeTime(post.created_at)}`), span(`· ${post.comment_count ?? 0} comments`));
    item.append(r1, r2, meta);
    item.addEventListener("click", () => selectPost(post.id));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter") selectPost(post.id);
    });
    list.append(item);
  }
}

function span(text) {
  const s = document.createElement("span");
  s.textContent = text;
  return s;
}

function renderDetail(thread) {
  const { post, comments } = thread;
  el("detail-state").hidden = true;
  el("detail").hidden = false;
  el("detail-title").textContent = post.title;
  const status = el("detail-status");
  status.replaceChildren(statusPill(post.status));
  el("detail-tags").replaceChildren(...[...tagList(post.tags).childNodes]);

  const by = el("detail-by");
  by.replaceChildren();
  const info = participantInfo(post.author);
  by.append(avatar(post.author, info.kind));
  const name = document.createElement("span");
  if (info.kind === "agent") name.className = "agent";
  name.textContent = post.author;
  by.append(name, span(`· posted ${relativeTime(post.created_at)}`));
  if (post.updated_at && post.updated_at !== post.created_at) by.append(span(`· updated ${relativeTime(post.updated_at)}`));

  renderSafeMarkdown(el("detail-body"), post.body);

  el("comments-label").textContent = `${comments.length} ${comments.length === 1 ? "comment" : "comments"}`;
  const wrap = el("comments");
  wrap.replaceChildren();
  for (const comment of comments) {
    wrap.append(renderComment(comment));
  }
}

function avatar(alias, kind) {
  const av = document.createElement("span");
  av.className = `av ${kind === "agent" ? "ag" : "hu"}`;
  av.textContent = initials(alias);
  return av;
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
  head.append(nm, spanClass("ci", `· ${info.kind === "agent" ? "agent" : "human"}`), spanClass("tm", `· ${relativeTime(comment.created_at)}`));
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

function spanClass(className, text) {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text;
  return s;
}

async function selectPost(id) {
  state.selected = id;
  renderList();
  shell.dataset.view = "detail";
  el("detail").hidden = true;
  el("detail-state").hidden = false;
  el("detail-state").textContent = "Loading thread…";
  el("detail-state").classList.remove("error");
  try {
    const res = await authFetch(`/forum/post?channel=${encodeURIComponent(channel)}&post=${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    renderDetail(await res.json());
  } catch {
    el("detail").hidden = true;
    el("detail-state").hidden = false;
    el("detail-state").textContent = "Could not load this post.";
    el("detail-state").classList.add("error");
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
    // comment_count is derived per-post from the thread; keep the list cheap by
    // defaulting to 0 and filling it when a post is opened.
    state.posts = (data.posts || []).map((p) => ({ comment_count: 0, ...p }));
    renderList();
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
      renderList();
    });
  }
}

function start() {
  el("forum-channel-title").textContent = channel ? `forum · #${channel}` : "forum";
  el("forum-channel-name").textContent = channel || "forum";
  wireFilters();
  el("comment-form").addEventListener("submit", submitComment);
  el("new-post-form").addEventListener("submit", submitNewPost);
  el("new-post").addEventListener("click", () => {
    el("new-post-form").hidden = !el("new-post-form").hidden;
  });
  el("new-post-cancel").addEventListener("click", () => {
    el("new-post-form").hidden = true;
  });
  el("forum-back").addEventListener("click", () => {
    shell.dataset.view = "list";
  });
  if (!channel) {
    setListState("No forum channel selected. Add ?channel=<forum-channel> to the URL.", true);
    return;
  }
  void loadParticipants().then(loadPosts);
}

start();
