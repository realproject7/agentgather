import { analyzeMentions } from "./mentions.js";
import { renderSafeMarkdown } from "./markdown.js";
import { describeWakeTier, wakeTierForMode } from "./wake-tier.js";
import { RESTORED_SENDER_LABEL, confirmedRestoredSender, isRestorableStoredType } from "./restored-provenance.js";

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
  // Room-entry lifecycle boundary (#241): idempotency guard covering both a later
  // token-fragment re-entry after entering and a re-entry while the joining
  // interstitial is shown. "unstarted" | "starting" | "joining" | "entering" |
  // "entered". A single guard keeps event bindings, poll/status timers, the
  // join-form binding, and the display-name claim to exactly one each.
  entryPhase: "unstarted",
  // Retained poll/status interval handles (#241) so they can be cleared once the
  // room reaches a terminal closed state — no timer keeps firing after closure.
  pollTimer: null,
  statusTimer: null,
  // Serialize pollMessages (#241): a fetch slower than the 3s interval must not let
  // overlapping timer callbacks issue several concurrent (closed-history) fetches.
  pollInFlight: false,
  // #249 host loop-guard control. Deadline is a local wall-clock target derived
  // from the server's reported seconds-remaining; the tick only repaints text
  // and never fetches, so this adds no poller of its own. Retained so it can be
  // cleared the moment nothing is pending (same timer discipline as #241).
  autoContinueDeadline: null,
  autoContinuePendingAlias: "",
  autoContinueCount: 0,
  autoContinueTick: null,
  // #268: true only once bindEvents() has attached the composer handlers. NOT
  // the same as entryPhase, which enterRoom() sets to "entered" BEFORE its
  // awaits — the whole window this guards is inside those awaits.
  composerReady: false,
  briefVersion: 0,
  replyTo: null,
  // Reply affordance (#113): minimal from/text record per rendered message id so
  // a message carrying reply_to can show compact replied-to context in the
  // timeline. Reuses the existing reply_to metadata — no new message schema.
  messagesById: new Map(),
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
  lastMessageTs: null,
  // T11 active chat session (null when idle); refreshed from /status on the 5s poll.
  activeSession: null,
  sessionInFlight: false,
  // Room name (from /status), used to key per-room notification prefs.
  roomName: null,
  // Human-readable boardroom display title (from /status boardroom.name), used
  // as the primary label when this join is recorded in "Rooms I'm in" (#216).
  boardroomTitle: null,
  // #211 read-only local backup: highest message id saved into this device's
  // bounded, redacted per-room snapshot. Drives the offline notice so the backup
  // view never implies complete unseen history beyond this cursor.
  backupCursor: 0,
  // #278: set while a restored history still has to be confirmed against the room.
  seedUnverified: false,
  // #283 on-demand backward read. `oldestId` is the lowest id currently ON SCREEN —
  // what the next backward page must stop before, so nothing already rendered is
  // refetched. `hasMore` is the host's stated answer, never inferred from a page's
  // length. Nothing here is a cursor: the live cursor is `state.cursor` and this
  // path never writes it.
  earlier: { oldestId: 0, restoredLowest: 0, restoredHighest: 0, loaded: 0, hasMore: false, inFlight: false, failed: false },
  // #312: ids seeded from the local copy this entry, awaiting per-row confirmation
  // against the host's log. Ids only — never the stored aliases.
  seededIds: [],
  seededConfirmed: false,
  // #247 offline-history bridge: the write-only capability this open was handed in
  // its entry fragment, held in memory for the life of the tab and nowhere else.
  // Absent unless the dashboard opened this room, which is exactly when a
  // dashboard-owned snapshot is wanted.
  snapshotCapability: null,
  // Browser notification layer (#186): opt-in, poll-driven (no push/SSE/worker).
  // enabled + scope persist per-room in sessionStorage; unread drives the title
  // badge + favicon dot while the tab is unfocused. ready gates out the initial
  // history backlog so only genuinely new messages notify.
  notify: { enabled: false, scope: "mentions", ready: false, focused: true, unread: 0 }
};

const shell = document.querySelector(".room-shell");
const authError = document.getElementById("auth-error");
const authDashboardRoute = document.getElementById("auth-dashboard-route");
const authDashboardLink = document.getElementById("auth-dashboard-link");
const joinPanel = document.getElementById("join-panel");
const joinForm = document.getElementById("join-form");
const displayNameInput = document.getElementById("display-name");
const joinError = document.getElementById("join-error");
const dashboardHome = document.getElementById("dashboard-home");
const brandStatic = document.getElementById("brand-static");
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
// The scrolling box the timeline sits in (#283 restores the reading position after
// older history is inserted above the viewport).
const timelineWrap = document.querySelector(".timeline-wrap");
const systemFilter = document.getElementById("system-filter");
const participantList = document.getElementById("participant-list");
const rosterToggle = document.getElementById("roster-toggle");
const notifyToggle = document.getElementById("notify-toggle");
const notifyScope = document.getElementById("notify-scope");
const faviconLink = document.querySelector('link[rel="icon"]');
const baseTitle = document.title;
const originalFavicon = faviconLink ? faviconLink.getAttribute("href") : null;
let dottedFavicon = null;
const composer = document.getElementById("composer");
const messageText = document.getElementById("message-text");
const sendButton = document.getElementById("send-button");

// #268: the composer is on screen and clickable from first paint, but
// `bindEvents()` only runs at the END of `enterRoom()` — after several awaits.
// In that window a native form submission would navigate the page, and entry has
// already cleared the token fragment (`replaceState`), so the reload lands
// unauthenticated and EJECTS the participant from the room. These two listeners
// are attached at load rather than in `bindEvents()` precisely because the bug is
// that bindings are late; `#send-button` is also `type="button"` so a click
// cannot submit at all. Both together mean no click and no Enter, with focus on
// any control, can navigate in any phase.
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.composerReady) {
    showEarlySendNotice();
    return;
  }
  void submitMessage();
});
sendButton.addEventListener("click", () => {
  if (!state.composerReady) {
    showEarlySendNotice();
    return;
  }
  void submitMessage();
});

// Honest, token-free notice: the message was not sent and the room is still
// being joined. Reuses the composer's existing role="alert" region.
function showEarlySendNotice() {
  sendError.textContent = "Still joining the room — wait for the roster to load, then send.";
  sendError.hidden = false;
}
const sendError = document.getElementById("send-error");
const replyIndicator = document.getElementById("reply-indicator");
const replyIndicatorLabel = document.getElementById("reply-indicator-label");
const replyClear = document.getElementById("reply-clear");
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
const backupNotice = document.getElementById("backup-notice");
const sessionBanner = document.getElementById("session-banner");
const sessionTitle = document.getElementById("session-title");
const sessionDetail = document.getElementById("session-detail");
const sessionControl = document.getElementById("session-control");
const sessionToggle = document.getElementById("session-toggle");
const autoContinueToggle = document.getElementById("auto-continue-toggle");
const autoContinueDelay = document.getElementById("auto-continue-delay");
const autoContinueState = document.getElementById("auto-continue-state");
const autoContinueError = document.getElementById("auto-continue-error");
const sessionError = document.getElementById("session-error");
const historyStrip = document.getElementById("history-strip");
const historySourceTag = document.getElementById("history-source-tag");
const historySourceNote = document.getElementById("history-source-note");
const historySummary = document.getElementById("history-summary");
const historyFootNote = document.getElementById("history-foot-note");
const historyKv = document.getElementById("history-kv");
const joinedSection = document.getElementById("joined-section");
const joinedList = document.getElementById("joined-list");
// "Rooms I'm in" (#178): device-local, same-origin join history. Metadata only —
// the token (state.token) is NEVER written here.
const JOINED_KEY = "agentgather.joinedRooms";
// Where this device's dashboard lives, as the dashboard itself once told this room
// (#279). An address only — never a token, never a bridge capability.
const DASHBOARD_KEY = "agentgather.dashboard";

init().catch((error) => showError(error instanceof Error ? error.message : String(error)));

async function init() {
  hydrateDashboardHome();
  const token = tokenFromEntryFragment() || sessionStorage.getItem("agentgather.token");
  if (!token) {
    authError.hidden = false;
    offerDashboardRoute();
    shell.dataset.state = "auth-error";
    window.addEventListener("hashchange", () => {
      const nextToken = tokenFromEntryFragment();
      if (nextToken) {
        authError.hidden = true;
        void startWithToken(nextToken);
      }
    });
    return;
  }
  await startWithToken(token);
}

// #290 — a link-opened tab inherits no credential, which is #288 working, not
// failing. But "ask the host for an invite URL" is only good advice when the
// arrival really has no way in; a device whose dashboard address is already
// remembered has one, because the dashboard reopens rooms through
// `/joined-rooms/open`, which holds the token SERVER-side.
//
// The route is therefore offered on exactly the condition that makes it true, and
// on no other. With no remembered dashboard this function touches nothing at all
// and the pane reads exactly as it did before this existed.
//
// What reaches the href is an ORIGIN, and it is one before it arrives here:
// `validLoopbackDashboardUrl` canonicalises (see #299 there). This function does no
// stripping of its own precisely so that it cannot be the place someone forgets to.
function offerDashboardRoute() {
  if (authDashboardRoute === null || authDashboardLink === null) return;
  // Already canonical: `dashboardTarget()` yields a validated loopback ORIGIN or
  // null. An address that will not parse — or carries a scheme or host this device
  // will not vouch for — is not a route, and offering nothing is the honest
  // outcome; a broken href would be an affordance that fails on click, which is
  // the thing this ticket exists to remove.
  const dashboardOrigin = dashboardTarget();
  if (dashboardOrigin === null) return;
  authDashboardLink.href = dashboardOrigin;
  authDashboardRoute.hidden = false;
}

function hydrateDashboardHome() {
  if (!dashboardHome || !brandStatic) return;
  // The route home must exist however this room was opened (#276) — an invite
  // link and a bookmark are the common cases, and neither carries `?dashboard=`.
  // `dashboardTarget` falls back to the address the dashboard itself supplied on
  // an earlier open (#279), so a direct open is no longer stranded. A room this
  // device has never opened from a dashboard still has none to offer, and the
  // affordance stays hidden rather than guessing one.
  //
  // #299 — this link is the OLDER of the two consumers of the remembered address
  // and shipped in v0.2.1–v0.2.3. It renders on every room page, not only the
  // auth-error pane, so it is the wider half of the same defect: the stored value
  // reached this `href` with its path, query and fragment intact. It is an origin
  // now because `validLoopbackDashboardUrl` returns one — the fix lives at the
  // boundary rather than here, so both consumers get it and a third cannot miss it.
  const dashboardOrigin = dashboardTarget();
  if (dashboardOrigin === null) return;
  dashboardHome.href = dashboardOrigin;
  dashboardHome.hidden = false;
  brandStatic.hidden = true;
}

// The dashboard to bridge to. A room opened FROM the dashboard carries the address
// in its query; a room opened by its own URL — an invite link, a bookmark — carries
// nothing, which is why its history never reached the dashboard at all (#279).
//
// The address the dashboard itself supplied on an earlier open is remembered so a
// later direct open still knows where this device's dashboard is. Only a validated
// loopback URL is ever stored — never a token and never a capability — and it is
// re-validated on read, because the store is editable by anything with script
// access to this origin. Nothing is discovered by probing: an address this
// dashboard never supplied stays unknown, and such a room stays honestly untracked.
function dashboardTarget() {
  const fromQuery = dashboardUrlFromQuery();
  if (fromQuery !== null) {
    try {
      window.localStorage.setItem(DASHBOARD_KEY, fromQuery);
    } catch {
      // A full or unavailable store costs the direct-open case, nothing else.
    }
    return fromQuery;
  }
  let remembered;
  try {
    remembered = window.localStorage.getItem(DASHBOARD_KEY);
  } catch {
    return null;
  }
  return remembered ? validLoopbackDashboardUrl(remembered) : null;
}

function dashboardUrlFromQuery() {
  return validLoopbackDashboardUrl(new URLSearchParams(window.location.search).get("dashboard"));
}

// A dashboard address is only ever a same-device loopback http(s) ORIGIN. Applied
// to the query value and, identically, to the remembered one — a stored address is
// untrusted input and must clear the same bar as a fresh one.
//
// #299/#290 — this returns the origin, not the URL. It used to return
// `url.toString()`, which validates the protocol and the host and then hands back
// the path, the query and the FRAGMENT untouched. `?dashboard=` is attacker-
// influenceable and is persisted to `localStorage`, so a stored value could carry
// chosen parameters — and this project's own invite-token carrier is the fragment
// — into an `href` the participant is invited to click. Two consumers already
// rendered that value as a link.
//
// Canonicalising HERE rather than at each assignment is the point: a third
// consumer cannot reintroduce the carrier by forgetting to strip it, because there
// is nothing left to strip. Same move as sharing an invariant rather than a
// renderer. `/joined-rooms/history` is an absolute root path on the dashboard
// server, so the bridge's target is unchanged by this.
//
// The validator gap is the `telegent` lane's @re2's finding.
function validLoopbackDashboardUrl(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!isLoopbackHost(url.hostname)) return null;
  return url.origin;
}

async function startWithToken(token) {
  // Idempotent room-entry boundary (#241): once entry has started, a later token
  // fragment (or a repeat while joining) must not re-drive the flow — that is what
  // previously double-bound the join form and double-started the poll timers.
  if (state.entryPhase !== "unstarted") return;
  state.entryPhase = "starting";
  try {
    state.token = token;
    sessionStorage.setItem("agentgather.token", state.token);
    try {
      state.profile = (await authFetch("/profile")).participant;
    } catch (error) {
      // A rejected credential must still refuse entry — showing a room for a token
      // this room does not accept would be a lie about being in it. Anything else
      // is the host failing while its page is still served (#279): enter read-only
      // so the copy this device already holds is readable instead of blank. The
      // profile stays null, which every consumer already guards for.
      if (error && (error.status === 401 || error.status === 403)) throw error;
      handlePollError(error);
    }
    if (state.profile && state.profile.kind === "human" && !state.profile.display_name) {
      if (state.profile.is_host && state.profile.alias) {
        await claimDisplayName(state.profile.alias);
        await enterRoom();
        return;
      }
      state.entryPhase = "joining";
      displayNameInput.value = state.profile.alias || "";
      joinPanel.hidden = false;
      shell.dataset.state = "joining";
      bindJoinForm();
      return;
    }
    await enterRoom();
  } catch (error) {
    // A failure before we commit to joining/entering (e.g. a bad token's /profile
    // fetch) reopens the boundary so a later valid token fragment can still enter.
    if (state.entryPhase === "starting") state.entryPhase = "unstarted";
    throw error;
  }
}

async function enterRoom() {
  // Enter exactly once: guards the event bindings and the poll/status timers so a
  // second entry (host path, or a submit after a re-entry) never duplicates them.
  if (state.entryPhase === "entered") return;
  state.entryPhase = "entered";
  joinPanel.hidden = true;
  // A host that serves this page but not its API — a broker still up with the host
  // gone, a restart, a quota — must not blank a room this device holds a copy of
  // (#279). `loadStatus` already tolerates that; `loadBrief` did not, and its
  // rejection aborted entry several statements before the backup was ever read.
  // Entry continues either way and the poll below drives the offline banner.
  await Promise.all([loadBrief().catch(handlePollError), loadStatus()]);
  hydrateNotifyPrefs();
  // Record this successful join in the device-local, same-origin history and show
  // it in the roster (metadata only — never the token).
  recordJoinedRoomLocal();
  renderJoinedRooms();
  // #278: restore this device's own copy BEFORE the first poll, and move the cursor
  // to the highest id it actually holds, so the poll below asks only for what is
  // new instead of re-downloading the whole history on every load. The write half
  // of this backup has existed since #211; this is the reader it never had.
  recoverRoomNameLocally();
  seedEntryFromBackup();
  // The first poll loads existing history; notifications stay off for it and only
  // arm (ready) afterwards so the backlog never fires a burst of notifications.
  await pollMessages();
  state.notify.ready = true;
  // If that first load already finalized a terminal (closed) room, do not start
  // any polling — a closed room loads its final history once and leaves no timer.
  if (!state.closedHistoryLoaded) {
    state.pollTimer = setInterval(() => void pollMessages(), 3000);
    state.statusTimer = setInterval(() => void loadStatus(), 5000);
  }
  bindEvents();
}

// Clear the retained poll/status timers so nothing keeps firing (#241). Idempotent.
function stopPolling() {
  if (state.pollTimer !== null) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.statusTimer !== null) {
    clearInterval(state.statusTimer);
    state.statusTimer = null;
  }
}

// A terminal (closed) room loads its read-only history exactly once, then all
// polling stops — no message or status timer remains active (#241).
function finalizeClosedRoom() {
  state.closedHistoryLoaded = true;
  stopPolling();
  applyRoomState();
}

function bindJoinForm() {
  joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitProfile();
  });
}

async function submitProfile() {
  // One claim + one entry even on a double submit: only proceed from the joining
  // interstitial, and hold the boundary at "entering" for the duration.
  if (state.entryPhase !== "joining") return;
  joinError.hidden = true;
  const displayName = displayNameInput.value.trim();
  if (!displayName) return;
  state.entryPhase = "entering";
  try {
    await claimDisplayName(displayName);
    await enterRoom();
  } catch (error) {
    // Reopen the interstitial so the human can correct the name and submit again.
    state.entryPhase = "joining";
    joinError.hidden = false;
    joinError.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function claimDisplayName(displayName) {
  const payload = await authFetch("/profile", {
    method: "POST",
    body: JSON.stringify({ display_name: displayName })
  });
  state.profile = payload.participant;
}

function bindEvents() {
  // #268: from here the composer's handlers exist, so Send may act.
  state.composerReady = true;
  // #323: publish that readiness on the composer itself. `state.composerReady`
  // was observable only from inside the page, so anything outside it had to
  // guess at entry from the brief text or from `.composer` — both true from
  // first paint, before the awaits in `enterRoom()`. A Send on that guess lands
  // inside #268's refusal window and is correctly refused, producing no POST at
  // all. This attribute is the only signal that means "armed"; it is set here,
  // beside the flag it mirrors, so the two cannot drift apart.
  composer.dataset.ready = "true";
  rosterToggle.addEventListener("click", () => shell.classList.toggle("roster-open"));
  notifyToggle.addEventListener("click", () => void toggleNotify());
  notifyScope.addEventListener("click", () => toggleNotifyScope());
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("blur", onWindowBlur);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onWindowFocus();
  });
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
    // Escape with the autocomplete closed clears a pending reply (#113).
    if (event.key === "Escape" && mentionAutocomplete.hidden && state.replyTo !== null) {
      event.preventDefault();
      clearReply();
      return;
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
  replyClear.addEventListener("click", () => {
    clearReply();
    messageText.focus();
  });
  closeButton.addEventListener("click", () => void closeRoom());
  sessionToggle.addEventListener("click", () => void toggleSession());
  autoContinueToggle.addEventListener("change", () => void saveAutoContinue());
  // Commit the delay on change/blur rather than per keystroke, so a partially
  // typed number is never sent. The server validates the bounds regardless.
  autoContinueDelay.addEventListener("change", () => void saveAutoContinue());
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

// Entry fragment. It carries this session's participant token and, when the open
// came from the dashboard, the write-only offline-snapshot capability (#247). Both
// are read here and the fragment is cleared in the same step, so neither value
// survives in the address bar, a history entry, or a copied URL. The capability
// stays in memory only — it is never stored, rendered, or logged.
function tokenFromEntryFragment() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get("token");
  const capability = fragment.get("snapshot");
  if (capability) state.snapshotCapability = capability;
  if (token || capability) {
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
  // Entry can now proceed without a profile when the host's API is down (#279).
  // That must not be a one-way door: the host is answering again here, so load the
  // identity this tab entered without. Otherwise the messages recover on the next
  // poll while the composer label, own-message marking and notification
  // suppression stay degraded for the life of the tab.
  if (state.profile === null) {
    try {
      state.profile = (await authFetch("/profile")).participant;
    } catch {
      // Still unavailable — the next status tick tries again.
    }
  }
  state.roomStatus = payload.room_status;
  state.roomName = payload.room;
  state.boardroomTitle = payload.boardroom?.name ?? null;
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
  renderAutoContinue(payload.loop_guard, Boolean(payload.is_host));
  rsActive.classList.toggle("on", payload.room_status !== "closed");
  closeButton.classList.toggle("on", payload.room_status === "closed");
  // T11 (#183): idle when absent, active while a session runs; the banner and the
  // host toggle render off this in applyRoomState -> renderSession.
  state.activeSession = payload.active_session || null;
  updateJoinFlips();
  applyRoomState();
}

// ---- #211 read-only local backup ----
// A device-local, bounded, redacted snapshot of messages this participant has
// already loaded from the host, kept per room on the room origin. When the host
// goes offline mid-session the room falls back to this snapshot read-only (see
// applyRoomState). Reuses the same redaction as the dashboard cache — a bearer
// token, tgl_ token, invite URL, or card URL is never persisted here.
const BACKUP_PREFIX = "agentgather.backup.";
const BACKUP_MAX_MESSAGES = 250;
const BACKUP_MAX_BYTES = 200_000;

// Scrub anything credential-shaped out of message text before it leaves the live
// view: a bearer token, tgl_ token, `token=`/`snapshot=` parameter, invite URL, or
// card URL is never written to the local backup nor handed to the dashboard
// bridge. Used by both persistence paths so they cannot drift apart.
function redactForBackup(value) {
  return String(value ?? "")
    .replace(/https?:\/\/(?=\S*(?:token=|snapshot=|tgl_|\/card))\S+/gi, "[redacted-url]")
    .replace(/Bearer\s+\S+/gi, "[redacted-credential]")
    .replace(/[#?&]?(?:token|snapshot)=[^\s&#"']+/gi, "[redacted-token]")
    .replace(/tgl_[A-Za-z0-9_-]+/g, "[redacted-token]")
    .slice(0, SNAPSHOT_MAX_TEXT_CHARS);
}

// #247 dashboard-owned snapshot: the room origin's localStorage backup above is
// unreadable once this host stops serving (its origin can no longer serve a page),
// so the same already-loaded messages are also handed to the dashboard that opened
// this room. Bounds mirror the local backup; the platform receiver re-checks them.
const SNAPSHOT_MAX_TEXT_CHARS = 4_000;
const SNAPSHOT_BRIDGE_MAX_BYTES = 150_000;

// Persist a bounded, redacted device-local backup of the messages we've loaded
// (#211): read the current per-room snapshot, append the new messages with any
// bearer/tgl_ token, token= param, invite URL, or card URL scrubbed out, drop the
// oldest past the count/byte cap, and write it back. Single self-contained flow —
// the redaction intentionally mirrors (does not import) the shell cache guard so
// the room bundle stays standalone. Never stores a secret.
function recordBackupBatch(messages) {
  if (messages.length === 0) return;
  const key = BACKUP_PREFIX + (state.roomName || "room");
  let list;
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    list = parsed && Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch {
    list = [];
  }
  for (const message of messages) {
    const text = redactForBackup(message.text);
    list.push({ id: message.id, from: message.from, ts: message.ts, type: message.type, text });
    if (typeof message.id === "number" && message.id > state.backupCursor) state.backupCursor = message.id;
  }
  // Bound by message count, then by serialized size — oldest dropped first.
  if (list.length > BACKUP_MAX_MESSAGES) list = list.slice(list.length - BACKUP_MAX_MESSAGES);
  while (list.length > 1 && JSON.stringify({ messages: list }).length > BACKUP_MAX_BYTES) list = list.slice(1);
  try {
    window.localStorage.setItem(key, JSON.stringify({ messages: list, updated_at: new Date().toISOString() }));
  } catch {
    // Storage full/unavailable — the live view is unaffected.
  }
}

// A restored record is ALWAYS rendered as an ordinary message. The stored `type`
// is discarded rather than normalised, because `system` is the room's own voice —
// a hand-edited store must not be able to speak in it — and `status` is a broadcast
// treatment. System records are not restored at all: they are room-authority
// statements ("<alias> joined", "room closed") whose value on a warm entry is low
// and whose forgery value is high.

// #278 — the reader the local backup never had. Every record is re-validated on the
// way in: this is data the page previously only wrote, and localStorage is editable
// by anything with script access to this origin, so it is treated as untrusted
// input. Ids must be positive integers, from/text must be strings, an unknown type
// collapses to "message", and the same redaction the writer applies is re-applied
// here so a hand-edited entry cannot smuggle a token back into the view. Anything
// malformed is dropped rather than coerced; a corrupt or absent store yields an
// empty list and entry proceeds exactly as it does today.
function readBackupForSeed() {
  let parsed;
  try {
    const raw = window.localStorage.getItem(BACKUP_PREFIX + (state.roomName || "room"));
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.messages)) return [];
  const byId = new Map();
  for (const entry of parsed.messages) {
    if (!entry || typeof entry !== "object") continue;
    if (!Number.isInteger(entry.id) || entry.id <= 0) continue;
    if (typeof entry.from !== "string" || typeof entry.text !== "string") continue;
    if (typeof entry.ts !== "string" || entry.ts.length === 0) continue;
    if (!isRestorableStoredType(entry.type)) continue;
    byId.set(entry.id, {
      id: entry.id,
      from: entry.from,
      ts: entry.ts,
      type: "message",
      text: redactForBackup(entry.text)
    });
  }
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

// Render the restored copy and hand the cursor to the first poll. The cursor is the
// highest id actually held — never higher — so the poll asks only for what is new
// and nothing between the two can be skipped. Restored rows are marked as such and
// introduced by a divider that states the range they cover, because a trimmed
// backup holds only the newest slice: the view must not imply it holds history it
// does not (the cursor-bounded honesty #247 established for the offline snapshot).
function seedEntryFromBackup() {
  const restored = readBackupForSeed();
  if (restored.length === 0) return;
  const lowest = restored[0].id;
  const highest = restored[restored.length - 1].id;
  // Note what is deliberately NOT done here: a restored record does not set
  // `state.lastMessageTs`. That renders in the roster as "last message · N ago",
  // which carries no restored marking — so a stored `ts` would become unmarked
  // room state. The roster reads "—" until the poll below supplies a live value,
  // which is the honest answer: this device knows what it holds, not when the
  // room last spoke.
  try {
    timeline.append(buildRestoredDivider(lowest, highest));
    for (const message of restored) {
      state.seen.add(message.id);
      renderMessage(message, { restored: true });
    }
  } catch {
    // Restoring is an optimisation, never a gate: if any stored record cannot be
    // rendered, drop the whole restore and let the poll below fetch from the start
    // exactly as it did before this existed.
    timeline.replaceChildren();
    state.seen.clear();
    resetCursor();
    state.backupCursor = 0;
    return;
  }
  seedCursorTo(highest);
  state.backupCursor = highest;
  // #283 — the backup holds only the newest slice; everything the cap dropped is
  // still on the host. `lowest > 1` is exactly the condition the divider already
  // reports as "earlier history isn't shown", so it is also the condition under
  // which a route to it exists. A restore that starts at #1 has nothing earlier to
  // reach and gets no control rather than a control that can only disappoint.
  state.earlier.restoredLowest = lowest;
  state.earlier.restoredHighest = highest;
  state.earlier.oldestId = lowest;
  state.earlier.hasMore = lowest > 1;
  if (state.earlier.hasMore) mountEarlierControl();
  // #312 — the ids this entry seeded from the local copy, so their authorship can
  // be confirmed against the host's own log once it answers. Held as ids only: the
  // stored aliases stay out of this path entirely, which is what makes attribution
  // impossible to launder from the store.
  state.seededIds = restored.map((message) => message.id);
  // The restore is provisional until the room confirms it holds that head (#278).
  state.seedUnverified = true;
  emptyState.hidden = true;
  updateLastMessage();
}

// Names the restored range so a trimmed backup reads honestly. `lowest > 1` means
// the oldest messages were dropped by the count/byte cap and are not held here.
function buildRestoredDivider(lowest, highest) {
  const item = document.createElement("li");
  item.className = "message system restored-divider";
  item.dataset.restored = "true";
  const pill = document.createElement("div");
  pill.className = "system-pill";
  const text = document.createElement("span");
  text.className = "message-text";
  text.textContent = restoredDividerText(lowest, highest);
  pill.append(text);
  item.append(pill);
  return item;
}

// The one label this feature must keep honest (#283). "Earlier history … isn't
// shown" is true only until earlier history is shown; once a backward read has put
// host-held messages above this line, the sentence describes the screen it is on
// rather than the store it was written for. Both variants still name the restored
// RANGE, so the divider never stops saying which rows are this device's copy.
function restoredDividerText(lowest, highest) {
  if (state.earlier.loaded > 0) {
    return `Restored from this device · messages #${lowest}–#${highest}. Earlier messages above were loaded from the host.`;
  }
  return lowest > 1
    ? `Restored from this device · messages #${lowest}–#${highest}. Earlier history isn't saved here and isn't shown.`
    : `Restored from this device · messages up to #${highest}.`;
}

function refreshRestoredDivider() {
  const text = timeline.querySelector(".restored-divider .message-text");
  if (text === null) return;
  text.textContent = restoredDividerText(state.earlier.restoredLowest, state.earlier.restoredHighest);
}

// ---- #283 the route to history older than this device holds ----
//
// #278 made a warm entry render the newest slice the local backup holds and fetch
// only what is new. Everything the cap dropped is still on the host; what was
// missing was any way to ask for it, which is why the divider above could only
// state the absence. This is that route — an explicit, one-click BACKWARD read,
// never a prefetch and never infinite scroll.
//
// Two properties are structural here rather than conventional:
//
//  1. It never touches the live cursor. It is not a poll and does not run through
//     `pollMessages()`, so it cannot reach that function's cursor tail; the only
//     writers of `state.cursor` remain the three named operations above. The wire
//     contract carries the same rule from the other side — a backward response
//     omits `next_since_id` — and neither half relies on the other.
//  2. What it loads is DISPLAY-ONLY: not written to the local backup (#211) and
//     not handed to the dashboard snapshot bridge (#247). Both stores are bounded
//     to the NEWEST slice on purpose, so feeding older messages into them would
//     evict newer ones to hold history that was asked for once — and raising those
//     caps is explicitly out of scope for this ticket.
const EARLIER_PAGE_SIZE = 50;

function mountEarlierControl() {
  const item = document.createElement("li");
  item.className = "message system earlier-history";
  item.id = "earlier-history";
  const pill = document.createElement("div");
  pill.className = "system-pill";
  const button = document.createElement("button");
  button.type = "button";
  button.id = "show-earlier";
  button.className = "earlier-btn";
  button.textContent = "Show earlier messages";
  button.addEventListener("click", () => void loadEarlierMessages());
  const note = document.createElement("span");
  note.className = "message-text earlier-note";
  note.hidden = true;
  pill.append(button, note);
  item.append(pill);
  // First row of the timeline, above the restored divider: older messages arrive
  // between the two, so ascending order holds without re-sorting anything.
  timeline.prepend(item);
  renderEarlierControl();
}

// The control states its own availability AND why, in the one place the reader is
// looking when they want older history. An affordance that is present but silently
// does nothing is worse than one that is absent, so an unreachable host removes the
// button and says so rather than offering a click that cannot succeed.
function renderEarlierControl() {
  const item = document.getElementById("earlier-history");
  if (item === null) return;
  const button = item.querySelector(".earlier-btn");
  const note = item.querySelector(".earlier-note");
  // Older history lives ONLY on the host — the local backup is what ran out. So
  // this control follows the host's reachability, not the room's open/closed
  // lifecycle: a closed room still serves its read-only log and keeps the route.
  const offline = state.connection === "degraded";
  const exhausted = !state.earlier.hasMore;
  button.hidden = exhausted || offline;
  button.disabled = state.earlier.inFlight;
  note.hidden = false;
  if (exhausted) note.textContent = "Beginning of this room's history.";
  else if (offline) note.textContent = "Earlier history is on the host — unavailable while it's offline.";
  else if (state.earlier.inFlight) note.textContent = "Loading earlier messages…";
  else if (state.earlier.failed) note.textContent = "Couldn't reach the host — earlier history wasn't loaded.";
  else note.hidden = true;
}

async function loadEarlierMessages() {
  if (state.earlier.inFlight || !state.earlier.hasMore) return;
  const before = state.earlier.oldestId;
  if (before <= 1) {
    state.earlier.hasMore = false;
    renderEarlierControl();
    return;
  }
  state.earlier.inFlight = true;
  state.earlier.failed = false;
  renderEarlierControl();
  let payload;
  try {
    // Backward, bounded, and ALWAYS with an explicit limit: an absent limit means
    // unbounded by contract (#283), which is the whole cost this feature exists to
    // avoid. `before_id` is the oldest id on screen, so the page stops exactly
    // where the rendered history starts and nothing already shown is refetched.
    payload = await authFetch(`/messages?before_id=${before}&limit=${EARLIER_PAGE_SIZE}`);
  } catch {
    // One failed backward read is not evidence the room is offline — the live poll
    // owns that verdict and has its own schedule — so this reports on the control
    // instead of flipping the whole view into local-backup mode. In a closed room
    // there is no poll at all, which is the other reason not to borrow its
    // machinery: nothing here starts, restarts, or requires a timer.
    state.earlier.inFlight = false;
    state.earlier.failed = true;
    renderEarlierControl();
    return;
  }
  const older = Array.isArray(payload.messages) ? payload.messages : [];
  // The restore can be discarded WHILE this fetch is in flight: the control is
  // clickable from the moment it mounts, and #278's head verification runs during
  // the first poll and may `replaceChildren()` the whole timeline away. There is
  // then nothing for this page to sit above — and nothing it is needed for, since
  // that path refetches the entire history from the start.
  const control = document.getElementById("earlier-history");
  if (control === null) {
    state.earlier.inFlight = false;
    return;
  }
  const anchor = control.nextSibling;
  // Hold the reading position. These rows are inserted ABOVE the viewport and a
  // scroll box keeps its scrollTop, so without this the view would jump down by
  // exactly the height of what just arrived.
  const fromBottom = timelineWrap === null ? 0 : timelineWrap.scrollHeight - timelineWrap.scrollTop;
  for (const message of older) {
    // Host-fetched rows are LIVE rows: they carry no restored marking, because the
    // host served them and this device is not vouching for them (#278's classes
    // stay distinct). The seen-set is what makes a re-render impossible.
    if (state.seen.has(message.id)) continue;
    state.seen.add(message.id);
    renderMessage(message, { before: anchor });
  }
  if (older.length > 0) state.earlier.oldestId = older[0].id;
  state.earlier.loaded += older.length;
  // Stated by the host, never inferred from page length: a page shorter than the
  // limit also occurs when the remainder is exactly one page.
  state.earlier.hasMore = payload.has_more_before === true;
  state.earlier.inFlight = false;
  refreshRestoredDivider();
  renderEarlierControl();
  if (timelineWrap !== null) {
    timelineWrap.scrollTo({ top: timelineWrap.scrollHeight - fromBottom, behavior: "instant" });
  }
}

// Hand one batch of ALREADY-RENDERED messages to the dashboard that opened this
// room, so the row stays readable after this host stops serving (#247). One-way
// and fire-and-forget: the response is never read, and no request is ever issued
// to the host in order to fill it — the batch is whatever the live poll just
// delivered. The capability travels in the body, never in a URL, and the target is
// the loopback dashboard origin this open already carries.
function bridgeHistoryToDashboard(messages) {
  if (messages.length === 0) return;
  const dashboard = dashboardTarget();
  if (dashboard === null) return;
  // A dashboard-opened room proves which room it is with the capability it was
  // handed. A direct open has none, so it names its own room instead — and the
  // receiver only accepts that name if it sits under the SAME origin the browser
  // reports for this request (#279). The caller still cannot choose a target
  // outside the host that served it, which is the property the capability existed
  // to give: a browser page cannot set `Origin`, so it can never name a room outside
  // the host that served it. (Against a non-browser local caller this is no defence
  // — nor was the capability; both rest on the loopback + tracked-row floor.)
  const claimedBaseUrl = state.snapshotCapability ? null : localBaseUrl();
  if (state.snapshotCapability === null && claimedBaseUrl === null) return;
  let target;
  try {
    target = new URL("joined-rooms/history", dashboard.endsWith("/") ? dashboard : `${dashboard}/`);
  } catch {
    return;
  }
  let batch = messages.map((message) => ({
    id: message.id,
    from: message.from,
    ts: message.ts,
    type: message.type,
    text: redactForBackup(message.text)
  }));
  // Bound what one POST can carry — the receiver rejects an oversized body, and a
  // first poll on a busy room can return a long history. Oldest go first.
  const body = () =>
    JSON.stringify({
      capability: state.snapshotCapability,
      baseUrl: claimedBaseUrl,
      roomId: claimedBaseUrl === null ? null : state.roomName,
      messages: batch
    });
  while (batch.length > 1 && body().length > SNAPSHOT_BRIDGE_MAX_BYTES) batch = batch.slice(1);
  void fetch(target.toString(), {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain" },
    body: body()
  }).catch(() => {
    // No dashboard reachable → the live view and the room-origin backup are
    // unaffected; the snapshot simply misses this batch.
  });
}

// ---- the live cursor's one rule (#283) ----
//
// `state.cursor` is what the next poll asks from. It had FIVE writers under three
// disciplines — reset, seed, bare assign, clamp — which is not an inconsistency but
// an absent rule, and #283 would have added a sixth caller to it. The rule is: the
// live cursor only ever moves FORWARD, except on an explicit reset. Each writer now
// names which of the three things it is doing, so the next reader does not have to
// infer it from the assignment.

// Entry has nothing, or what we held turned out not to belong to this room: ask
// from the beginning again.
function resetCursor() {
  state.cursor = 0;
}

// Entry restored a local copy: start from the highest id it actually holds.
function seedCursorTo(id) {
  state.cursor = id;
}

// A live message or poll batch arrived: move up to it, never back. This is what
// makes a rewind — and an `undefined` from a response that carries no forward
// cursor — unreachable by construction rather than by the wire contract alone.
function advanceCursorTo(id) {
  if (Number.isInteger(id) && id > state.cursor) state.cursor = id;
}

// #278 — a restored cursor must never sit ahead of the room. If the first poll
// after a restore returns nothing, "nothing new" and "this backup belongs to a room
// that no longer exists" look identical: a room recreated under the same name
// restarts ids at 1, and a hand-edited store can claim any id, either of which
// would leave the cursor at a value the host never reaches and no message would
// ever arrive again. So ask once for the single message the backup calls newest.
// If the room really has it, the restore is consistent and nothing further happens.
// If it does not, the restore is discarded and entry refetches from the start.
async function verifyRestoredHead() {
  const head = state.backupCursor;
  if (head <= 0) return true;
  let payload;
  try {
    payload = await authFetch(`/messages?since_id=${Math.max(0, head - 1)}`);
  } catch {
    // A transport failure proves nothing; leave the restore and let a later poll
    // decide rather than throwing away history over a blip.
    return true;
  }
  if (payload.messages.some((message) => message.id === head)) return true;
  discardRestoredHistory();
  return false;
}

// #312 — earn the author of each seeded row from the host's own log, or leave it
// saying `local copy`.
//
// #278 made a warm entry render the local copy, and #279's rule then labelled every
// one of those rows `local copy` — correct when nothing can check the store, wrong
// when the host is reachable and serving the very ids being seeded. In a
// coordination room that made every backfilled line anonymous, which is the thing
// the room exists to show.
//
// Three properties, each deliberate:
//
//  1. PER ROW, from the HOST. The host's own records are fetched and matched by id;
//     a row is attributed only where the host's log holds that id, and it is the
//     HOST's `from` that renders. The stored alias never enters this path — the ids
//     are all that was kept — so a hand-edited store cannot put words in a named
//     participant's mouth no matter how healthy the connection is.
//  2. NON-BLOCKING. Entry still paints instantly from the local copy; this runs
//     after the first poll has already proved the host answers. The latency #278
//     bought is untouched. It does re-read the seeded range once, bounded by
//     #211's cap rather than by room size.
//  3. PROVENANCE SURVIVES. The row keeps `data-restored="true"`, its restored
//     avatar and its restored kind. What changes is only the one thing the host
//     confirmed: who wrote it. The row is still this device's copy, and still says
//     so — it is no longer anonymous about the author.
//
// A transport failure proves nothing, so rows simply stay `local copy`.
async function confirmSeededAuthors() {
  if (state.seededConfirmed || state.seededIds.length === 0) return;
  state.seededConfirmed = true;
  const ids = state.seededIds;
  const lowest = ids[0];
  const highest = ids[ids.length - 1];
  // Bound by the id SPAN, not by how many rows were seeded (@re1, PR #315).
  // `system` and `status` records are dropped from the store at read time
  // (`isRestorableStoredType`), so whenever one sits between two seeded rows the
  // host's range holds more records than the store does. A count-bounded read then
  // truncates the host's log before the later ids and leaves rows the host WOULD
  // have confirmed saying `local copy` — worst in exactly the rooms with the most
  // system chatter. The span is the number of ids that can exist in the range, so
  // it cannot truncate; it is still bounded by #211's cap rather than room size.
  const span = highest - lowest + 1;
  let payload;
  try {
    payload = await authFetch(`/messages?since_id=${Math.max(0, lowest - 1)}&limit=${span}`);
  } catch {
    return;
  }
  const hostById = new Map();
  for (const record of Array.isArray(payload.messages) ? payload.messages : []) {
    hostById.set(record.id, record);
  }
  for (const id of ids) {
    const row = timeline.querySelector(`li[data-message-id="${id}"][data-restored="true"]`);
    if (row === null) continue;
    // The host record for THIS id, or nothing. `confirmedRestoredSender` returns
    // the label when it is handed nothing, so an unconfirmed row is untouched by
    // construction rather than by remembering to check.
    const hostRecord = hostById.get(id) ?? null;
    // The host's record must itself be renderable as restored content (@re1, PR
    // #315). A tampered store can claim `type: "chat"` on an id the host holds as
    // `system` or `status`; replacing from that record would render the room's own
    // voice as an ordinary restored row — #278's type boundary breached through the
    // back door, by the very step meant to make rows trustworthy. Such a record
    // confirms nothing, so the row keeps its pre-#312 presentation: `local copy`,
    // its stored text, no attribution.
    const usable = hostRecord !== null && isRestorableStoredType(hostRecord.type) ? hostRecord : null;
    const sender = confirmedRestoredSender(usable);
    if (sender === RESTORED_SENDER_LABEL) continue;
    const from = row.querySelector(".message-from");
    const body = row.querySelector(".message-text");
    if (from === null || body === null) continue;
    // A confirmed ID IS NOT A CONFIRMED ROW (@re2, PR #315). The store supplies the
    // text; the host supplies only the author. Writing one onto the other produces
    // the worst possible row — forged content under a real participant's name,
    // which is strictly worse than the label bug this ticket fixes and exactly the
    // trade the operator refused. #278's own tampered-backup guard proves it.
    //
    // So a confirmed row is REPLACED by the host's record, not annotated with part
    // of it: author and text both come from the host, and nothing store-supplied
    // survives. Redaction is re-applied on the way in, as at seed time, because a
    // restored region stays uniformly redacted whatever its content's origin.
    from.textContent = state.participantLabels.get(sender) || sender;
    renderSafeMarkdown(body, redactForBackup(String(usable.text ?? "")), { mentions: state.participants });
    row.dataset.authorConfirmed = "true";
  }
}

// Drop everything the restore contributed and return to the pre-#278 behaviour:
// an empty timeline and a fetch from the start. The stored copy is removed too —
// it has been shown to belong to some other room's numbering, so keeping it would
// only wedge the next entry as well.
function discardRestoredHistory() {
  timeline.replaceChildren();
  state.seen.clear();
  state.messagesById.clear();
  resetCursor();
  state.backupCursor = 0;
  state.lastMessageTs = null;
  // The restored region is gone and with it its control (`replaceChildren` above),
  // so the backward read has nothing to sit above. Entry refetches from the start
  // and holds the whole history, which is the state where no earlier route exists.
  state.earlier = { oldestId: 0, restoredLowest: 0, restoredHighest: 0, loaded: 0, hasMore: false, inFlight: false, failed: false };
  try {
    window.localStorage.removeItem(BACKUP_PREFIX + (state.roomName || "room"));
  } catch {
    // Nothing to do: the in-memory reset above is what matters.
  }
}

async function pollMessages() {
  // A closed room is loaded exactly once: GET /messages still serves the host's
  // read-only history (it never required the room to be open), but there is
  // nothing further to poll for.
  if (state.roomStatus === "closed" && state.closedHistoryLoaded) return;
  // Serialize: if a poll is already awaiting its fetch, a later timer callback
  // skips instead of issuing a second concurrent fetch. This guarantees a closed
  // room's final history is fetched exactly once even if a fetch runs long.
  if (state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    let payload;
    try {
      payload = await authFetch(`/messages?since_id=${state.cursor}`);
    } catch (error) {
      state.historyAvailable = false;
      handlePollError(error);
      if (state.roomStatus === "closed") {
        finalizeClosedRoom();
      }
      return;
    }
    markConnectionLive();
    state.historyAvailable = true;
    const fresh = [];
    for (const message of payload.messages) {
      if (state.seen.has(message.id)) continue;
      state.seen.add(message.id);
      renderMessage(message);
      fresh.push(message);
      // De-dup is inherent: the seen-set guard means each id reaches maybeNotify once.
      maybeNotify(message);
      if (message.ts) state.lastMessageTs = message.ts;
    }
    // Persist the redacted, bounded local backup of what we've now loaded (#211),
    // and hand the same already-loaded batch to the dashboard snapshot (#247).
    // Both take `fresh` — the messages this poll just rendered — so neither can
    // reach for history the participant has not already received.
    recordBackupBatch(fresh);
    bridgeHistoryToDashboard(fresh);
    updateLastMessage();
    advanceCursorTo(payload.next_since_id);
    if (state.seedUnverified) {
      state.seedUnverified = false;
      // Only an empty first poll is ambiguous; anything returned proves the room's
      // ids already run past the restored cursor.
      if (payload.messages.length === 0 && !(await verifyRestoredHead())) {
        state.pollInFlight = false;
        await pollMessages();
        return;
      }
      // #312 — the restore has survived verification and the host has answered, so
      // its log is available to confirm who wrote the seeded rows. Deliberately
      // here and not at seed time: this must not gate first paint, and a host that
      // never answers must leave every row saying `local copy`.
      await confirmSeededAuthors();
    }
    emptyState.hidden = state.seen.size > 0 || state.roomStatus === "closed";
    if (state.roomStatus === "closed") {
      finalizeClosedRoom();
    }
  } finally {
    state.pollInFlight = false;
  }
}

// ---- browser notification layer (#186): opt-in, poll-driven, no push service ----
// Decide + fire for one freshly-seen message. Never notifies own messages or system
// lines; @mentions always notify when enabled, other messages only in "all" scope.
// When the tab is focused the human is already looking, so nothing fires.
function maybeNotify(message) {
  if (!state.notify.enabled || !state.notify.ready) return;
  if (message.type === "system") return;
  if (state.profile && message.from === state.profile.alias) return;
  const mentioned =
    Array.isArray(message.mentions) && state.profile !== null && message.mentions.includes(state.profile.alias);
  if (!mentioned && state.notify.scope !== "all") return;
  if (state.notify.focused) return;
  state.notify.unread += 1;
  updateUnreadIndicators();
  fireOsNotification(message, mentioned);
}

// OS notification, only when permission is actually granted. Permission-denied (or
// no Notification API) degrades silently to the title badge handled above.
// Privacy (#186): the body is GENERIC — never the message text. The OS surfaces
// this outside the app (notification center / lock screen), and agentgather invite
// URLs carry participant tokens, so quoting message content there could leak a
// secret a peer pasted. Only the sender alias (already public in the roster) and
// the room name appear; the human opens the tab to read the actual message.
function fireOsNotification(message, mentioned) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const sender = state.participantLabels.get(message.from) || message.from;
  const room = state.roomName || "the room";
  const title = `Agent Gather · ${room}`;
  const body = mentioned ? `New mention from ${sender}` : `New message from ${sender}`;
  try {
    // tag keyed by message id → the OS coalesces, so a message never double-notifies.
    new Notification(title, { body, tag: `agentgather-${message.id}` });
  } catch {
    // A hostile browser or blocked context must not break the poll loop.
  }
}

// Title unread count + favicon dot, shown only while unfocused. Both clear on focus.
function updateUnreadIndicators() {
  const show = state.notify.unread > 0 && !state.notify.focused;
  document.title = show ? `(${state.notify.unread}) ${baseTitle}` : baseTitle;
  applyFavicon(show);
}

function applyFavicon(showDot) {
  if (!faviconLink || originalFavicon === null) return;
  if (showDot && dottedFavicon !== null) faviconLink.setAttribute("href", dottedFavicon);
  else faviconLink.setAttribute("href", originalFavicon);
}

// Compose an accent dot onto the existing favicon once, cached. Same-origin image →
// the canvas is not tainted, so toDataURL works; any failure degrades to title only.
function ensureDottedFavicon() {
  if (dottedFavicon !== null || faviconLink === null || originalFavicon === null) return;
  const image = new Image();
  image.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext("2d");
      if (ctx === null) return;
      ctx.drawImage(image, 0, 0, 32, 32);
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ec5c94";
      ctx.beginPath();
      ctx.arc(24, 8, 7, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      dottedFavicon = canvas.toDataURL("image/png");
      applyFavicon(state.notify.unread > 0 && !state.notify.focused);
    } catch {
      // Leave dottedFavicon null → title badge still works.
    }
  };
  image.src = originalFavicon;
}

function onWindowFocus() {
  state.notify.focused = true;
  state.notify.unread = 0;
  updateUnreadIndicators();
}

function onWindowBlur() {
  state.notify.focused = false;
}

async function toggleNotify() {
  if (state.notify.enabled) {
    setNotifyEnabled(false);
    return;
  }
  // Requesting permission needs this click as the user gesture. Enable regardless of
  // the outcome: granted → OS notifications, denied/unsupported → title badge only.
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      // Older callback-only browsers or a hostile override — treat as no decision.
    }
  }
  setNotifyEnabled(true);
}

function setNotifyEnabled(enabled) {
  state.notify.enabled = enabled;
  if (enabled) {
    ensureDottedFavicon();
  } else {
    state.notify.unread = 0;
    updateUnreadIndicators();
  }
  persistNotifyPrefs();
  updateNotifyUi();
}

function toggleNotifyScope() {
  state.notify.scope = state.notify.scope === "all" ? "mentions" : "all";
  persistNotifyPrefs();
  updateNotifyUi();
}

function updateNotifyUi() {
  const on = state.notify.enabled;
  notifyToggle.setAttribute("aria-pressed", String(on));
  notifyToggle.textContent = on ? "notify on" : "notify";
  const blocked = typeof Notification !== "undefined" && Notification.permission === "denied";
  notifyToggle.title = on
    ? blocked
      ? "Notifications are blocked by the browser — showing an unread badge only"
      : "Notifying on new messages while this tab is open"
    : "Notify me of new messages while this tab is open";
  notifyScope.hidden = !on;
  notifyScope.textContent = state.notify.scope === "all" ? "all" : "mentions";
  notifyScope.setAttribute("aria-pressed", String(state.notify.scope === "all"));
}

function notifyStorageKey() {
  return `agentgather.notify.${state.roomName || "room"}`;
}

function persistNotifyPrefs() {
  try {
    sessionStorage.setItem(
      notifyStorageKey(),
      JSON.stringify({ enabled: state.notify.enabled, scope: state.notify.scope })
    );
  } catch {
    // Private-mode storage failures must not break notifications.
  }
}

function hydrateNotifyPrefs() {
  state.notify.focused = document.hasFocus();
  try {
    const raw = sessionStorage.getItem(notifyStorageKey());
    if (raw) {
      const prefs = JSON.parse(raw);
      state.notify.enabled = Boolean(prefs.enabled);
      state.notify.scope = prefs.scope === "all" ? "all" : "mentions";
    }
  } catch {
    // Ignore malformed stored prefs; fall back to the defaults (off / mentions).
  }
  if (state.notify.enabled) ensureDottedFavicon();
  updateNotifyUi();
}

// ---- "Rooms I'm in" (#178): device-local same-origin join history ----
// The platform dashboard is a different origin than the room, so a browser join is
// recorded here (room origin) — metadata only. The base URL is the room's own
// origin+path; the token in state.token is never persisted, matching the notify /
// cache invariant that localStorage holds no bearer token.
function recordJoinedRoomLocal() {
  if (!state.profile || !state.roomName) return;
  const baseUrl = localBaseUrl();
  if (baseUrl === null) return;
  const now = new Date().toISOString();
  const rooms = readJoinedLocal().filter((room) => room.baseUrl !== baseUrl);
  const existing = readJoinedLocal().find((room) => room.baseUrl === baseUrl);
  // Primary label is the human-readable boardroom title (#216); the slug-like
  // room id is only the fallback when no display title is known. Keep a real
  // title already stored locally rather than downgrading it to the slug.
  const title = state.boardroomTitle || (existing && existing.title !== state.roomName ? existing.title : state.roomName);
  rooms.push({
    roomId: state.roomName,
    title,
    alias: state.profile.alias,
    baseUrl,
    joinedAt: existing ? existing.joinedAt : now,
    lastSeen: now
  });
  writeJoinedLocal(rooms);
  bridgeJoinToDashboard(baseUrl);
}

// Same-device bridge (#178): localStorage is origin-scoped, so the owner dashboard
// (a different origin) can't see this room-origin record. When the room was opened
// from the dashboard it carries `?dashboard=<origin>`; POST the token-free metadata
// there so the join also appears in the dashboard's "Rooms I'm in". Fire-and-forget
// and no-cors — we never read the response, and only metadata (never the token) is
// sent.
//
// This tab knows only the credential it was opened with, so the POST is a metadata
// REFRESH, never an identity claim (#248). The dashboard treats it that way: the
// alias below is used to label a row it does not have yet, and can never replace
// the identity already selected for an existing row — a stale tab authenticated as
// another participant cannot repoint that row at itself. Changing the selected
// identity is the dashboard's explicit invite import / CLI join.
function bridgeJoinToDashboard(baseUrl) {
  const dashboard = new URLSearchParams(window.location.search).get("dashboard");
  if (!dashboard || !state.profile || !state.roomName) return;
  let target;
  try {
    target = new URL("joined-rooms", dashboard.endsWith("/") ? dashboard : `${dashboard}/`);
  } catch {
    return;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return;
  // The platform dashboard is same-device (localhost). Refuse any non-loopback
  // target so a hostile ?dashboard= can never exfiltrate the join metadata off-box.
  if (!isLoopbackHost(target.hostname)) return;
  const body = JSON.stringify({
    roomId: state.roomName,
    title: state.boardroomTitle || state.roomName,
    alias: state.profile.alias,
    baseUrl
  });
  void fetch(target.toString(), {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain" },
    body
  }).catch(() => {
    // Best-effort: no dashboard reachable → the room-roster list still has it.
  });
}

function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function renderJoinedRooms() {
  const rooms = readJoinedLocal();
  joinedSection.hidden = rooms.length === 0;
  joinedList.replaceChildren();
  for (const room of rooms) {
    const item = document.createElement("li");
    item.className = "joined-row";
    const name = document.createElement("span");
    name.className = "joined-name";
    name.textContent = room.title || room.roomId || room.baseUrl;
    const sub = document.createElement("span");
    sub.className = "joined-sub";
    sub.textContent = room.alias ? `${room.alias} · ${hostLabel(room.baseUrl)}` : hostLabel(room.baseUrl);
    item.append(name, sub);
    joinedList.append(item);
  }
}

function hostLabel(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl || "";
  }
}

// This room's identity as a URL — origin + path, no query or fragment, so a token
// can never be part of it. Both the joined-room record and the offline room-name
// recovery below key on exactly this value.
function localBaseUrl() {
  try {
    const url = new URL(document.baseURI);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "") || url.origin;
  } catch {
    return null;
  }
}

// Offline, `/status` never arrives, so `state.roomName` stays null and the backup
// key would fall back to the generic "room" and find nothing — the local copy would
// be present and unreadable (#279). This device's own joined-room list already
// records which room this URL is, so recover the name from there. It is this
// device's own prior observation, not a guess about the unreachable host.
function recoverRoomNameLocally() {
  if (state.roomName) return;
  const baseUrl = localBaseUrl();
  if (baseUrl === null) return;
  const match = readJoinedLocal().find((room) => room.baseUrl === baseUrl);
  if (match && typeof match.roomId === "string" && match.roomId.length > 0) state.roomName = match.roomId;
}

function readJoinedLocal() {
  try {
    const raw = window.localStorage.getItem(JOINED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.rooms) ? parsed.rooms : [];
  } catch {
    return [];
  }
}

function writeJoinedLocal(rooms) {
  try {
    window.localStorage.setItem(JOINED_KEY, JSON.stringify({ rooms }));
  } catch {
    // Private-mode / full storage: the list simply will not persist.
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
  replyIndicatorLabel.textContent = "";
  hideMentionWarning();
  // A broadcast is a deliberate one-shot; return to direct so the next message
  // is not accidentally sent room-wide.
  if (broadcast) setBroadcast(false);
  autoGrowComposer();
  if (payload.message && !state.seen.has(payload.message.id)) {
    state.seen.add(payload.message.id);
    renderMessage(payload.message);
    advanceCursorTo(payload.message.id);
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

// Host-only start/end of the T11 active chat session (#183). Start prompts for a
// duration; end confirms. The server appends the start/end system message (T11),
// so there is no separate toast — the timeline carries the "session ended" line.
// #249: reflect the server's loop-guard state. The server is the authority —
// this only renders what /status reports and posts host intent back. The
// countdown ticks locally between status polls so the number stays honest
// without adding a poller of its own.
function renderAutoContinue(loopGuard, isHost) {
  if (!isHost || !loopGuard) {
    state.autoContinueDeadline = null;
    return;
  }
  // Never fight the host mid-edit: skip while either control has focus.
  const editing = document.activeElement === autoContinueToggle || document.activeElement === autoContinueDelay;
  if (!editing) {
    autoContinueToggle.checked = loopGuard.auto_continue_enabled === true;
    autoContinueDelay.value = String(loopGuard.auto_continue_delay_s);
    autoContinueDelay.disabled = loopGuard.auto_continue_enabled !== true;
  }
  state.autoContinueCount = loopGuard.auto_continue_count || 0;
  state.autoContinueDeadline =
    loopGuard.pending === true ? Date.now() + (loopGuard.pending_seconds_remaining || 0) * 1000 : null;
  state.autoContinuePendingAlias = loopGuard.pending === true ? loopGuard.pending_alias || "" : "";
  syncAutoContinueTick();
  paintAutoContinueState();
}

// Exactly one repaint interval, and only while a continuation is pending.
function syncAutoContinueTick() {
  const shouldTick = state.autoContinueDeadline !== null;
  if (shouldTick && state.autoContinueTick === null) {
    state.autoContinueTick = setInterval(paintAutoContinueState, 1000);
  } else if (!shouldTick && state.autoContinueTick !== null) {
    clearInterval(state.autoContinueTick);
    state.autoContinueTick = null;
  }
}

function paintAutoContinueState() {
  const parts = [];
  if (state.autoContinueDeadline !== null) {
    const seconds = Math.max(0, Math.ceil((state.autoContinueDeadline - Date.now()) / 1000));
    const who = state.autoContinuePendingAlias ? ` for @${state.autoContinuePendingAlias}` : "";
    parts.push(`paused${who} · continuing in ${seconds}s`);
  }
  if (state.autoContinueCount > 0) {
    parts.push(`${state.autoContinueCount} auto-continue${state.autoContinueCount === 1 ? "" : "s"} this session`);
  }
  autoContinueState.textContent = parts.join(" · ");
  autoContinueState.hidden = parts.length === 0;
}

async function saveAutoContinue() {
  const enabled = autoContinueToggle.checked;
  const delay = Number(autoContinueDelay.value);
  autoContinueError.hidden = true;
  autoContinueToggle.disabled = true;
  autoContinueDelay.disabled = true;
  try {
    const payload = await authFetch("/loop-guard", {
      method: "POST",
      body: JSON.stringify({ enabled, delay_s: Number.isInteger(delay) ? delay : undefined })
    });
    renderAutoContinue(payload.loop_guard, true);
  } catch (error) {
    autoContinueError.textContent = error instanceof Error ? error.message : "could not save auto-continue";
    autoContinueError.hidden = false;
    autoContinueToggle.checked = !enabled;
  } finally {
    autoContinueToggle.disabled = false;
    autoContinueDelay.disabled = !autoContinueToggle.checked;
  }
}

async function toggleSession() {
  if (state.sessionInFlight || state.roomStatus === "closed") return;
  const active = Boolean(state.activeSession);
  let body;
  if (active) {
    if (!window.confirm("End the active chat session for everyone in #general?")) return;
    body = { action: "end" };
  } else {
    const raw = window.prompt("Session length in minutes?", "30");
    if (raw === null) return;
    const minutes = Number.parseInt(raw, 10);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      showSessionError("Enter a whole number of minutes greater than zero.");
      return;
    }
    body = { action: "start", expected_duration_m: minutes };
  }
  sessionError.hidden = true;
  state.sessionInFlight = true;
  sessionToggle.disabled = true;
  try {
    await authFetch("/session", { method: "POST", body: JSON.stringify(body) });
    await loadStatus();
  } catch (error) {
    showSessionError(error instanceof Error ? error.message : String(error));
  } finally {
    state.sessionInFlight = false;
    sessionToggle.disabled = false;
  }
}

function showSessionError(message) {
  sessionError.textContent = message;
  sessionError.hidden = false;
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
    // Host role is modeled separately from kind (V2 #169): the host row keeps its
    // group (agent host → AGENTS) and carries an explicit `agent · host` /
    // `human · host` badge so the host's kind reads on the row itself — no new
    // card or layout shift. Non-host rows leave kind implied by the group header.
    const hostPart = participant.is_host ? `${participant.kind} · host · ` : "";
    meta.append(document.createTextNode(`${aliasPart}${hostPart}`));
    // 9A: show the negotiated effective attention mode; when degraded (the host
    // requested a more capable mode than the participant can provide) show both
    // as `requested→effective`. effective_mode is always a declared mode or the
    // manual floor, so the roster never claims an undeclared capability.
    if (participant.effective_mode) {
      const modeText =
        participant.requested_mode && participant.requested_mode !== participant.effective_mode
          ? `${participant.requested_mode}→${participant.effective_mode}`
          : participant.effective_mode;
      meta.append(document.createTextNode(`${modeText} `));
      // Wake-tier chip (#185) next to the effective mode, derived from the SAME
      // protocol function the attend card uses. Only rendered when a mode is
      // declared, so it never claims an undeclared wake capability.
      const tier = wakeTierForMode(participant.effective_mode);
      const chip = document.createElement("span");
      chip.className = "tier-chip k-pill";
      chip.dataset.tier = tier;
      chip.textContent = `Tier ${tier}`;
      chip.title = describeWakeTier(tier).headline;
      meta.append(chip);
      meta.append(document.createTextNode(" · "));
    }
    meta.append(document.createTextNode(formatRelative(participant.lastSeenAt)));
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

function renderMessage(message, options = {}) {
  const restoredRow = options.restored === true;
  // #283 — older history is inserted ABOVE what is already on screen, in ascending
  // order, and never scrolls the view to itself: the reader asked to see the top of
  // the timeline, not to be moved to it. Every other caller appends and follows the
  // newest row exactly as before.
  const before = options.before instanceof Node ? options.before : null;
  const place = (node) => {
    if (before !== null) {
      timeline.insertBefore(node, before);
      return;
    }
    timeline.append(node);
    node.scrollIntoView({ block: "nearest" });
  };
  // Record a minimal from/text preview so a later message carrying reply_to can
  // show its replied-to context, even for a message rendered earlier (#113).
  //
  // Restored records do not take part in this at all (#278). Marking the ROW is
  // not enough when its data flows onward: what this map feeds renders inside a
  // *live* row, which carries no restored marking, so a hand-edited alias would be
  // laundered — roster-resolved on the way in — into a line the host really served.
  // Sanitising each consumer would leave the next one to be written unguarded, so
  // the restored record never enters the map, and a live reply to an id only this
  // device holds falls back to the existing `↩ replying to #n`.
  if (!restoredRow) state.messagesById.set(message.id, { from: labelFor(message.from), text: message.text });

  const item = document.createElement("li");
  item.className = `message ${message.type === "system" ? "system" : ""}`;
  // #278: a row restored from this device's backup is marked as such, so nothing
  // read back out of local storage can present itself as a line the host just
  // served — including a hand-edited entry claiming to be from the host or system.
  if (options.restored === true) item.dataset.restored = "true";
  if (message.type === "status") item.classList.add("broadcast");
  // A restored row never wears another participant's presentation — including the
  // viewer's own (#278, @re2). `own` is claimed from the stored `from`, so a
  // hand-edited record naming the viewer would otherwise render as something they
  // sent themselves.
  if (!restoredRow && state.profile && message.from === state.profile.alias) item.classList.add("own");
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
    place(item);
    return;
  }

  const from = document.createElement("div");
  from.className = "message-from";
  // #278: a restored row carries a FIXED local provenance label and never its
  // stored sender. The alias in the backup is attacker-controlled — anything with
  // script access to this origin can edit that store — so displaying it at all lets
  // a hand-edited record read as "the host said this", which no neutral styling
  // undoes. The stored alias therefore does not reach the DOM; what the row asserts
  // is only what this device can actually vouch for: that it holds this text.
  from.textContent = restoredRow ? RESTORED_SENDER_LABEL : state.participantLabels.get(message.from) || message.from;
  const senderKind = restoredRow ? "restored" : state.participantKinds.get(message.from) || "human";
  from.dataset.kind = senderKind;

  const avatar = document.createElement("div");
  avatar.className = `message-avatar ${restoredRow ? "restored" : senderKind === "agent" ? "agent" : "human"}`;
  avatar.textContent = restoredRow ? "·" : initialsFor(state.participantLabels.get(message.from) || message.from);

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

  // Discoverable per-message reply action (#113): a visible button (also
  // keyboard-focusable) that sets the composer reply target. Double-click still
  // works as a shortcut. A restored row carries neither (#278): both name an
  // author — the button in its `aria-label`, the composer in its indicator — and
  // the only alias they could name is the stored one.
  if (!restoredRow) {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const replyBtn = document.createElement("button");
    replyBtn.type = "button";
    replyBtn.className = "reply-btn";
    replyBtn.textContent = "↩ Reply";
    replyBtn.setAttribute("aria-label", `Reply to ${state.participantLabels.get(message.from) || message.from} #${message.id}`);
    replyBtn.addEventListener("click", () => setReply(message));
    actions.append(replyBtn);
    meta.append(actions);
  }

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.append(meta);
  // Replied-to context: reuse the existing reply_to metadata (no new schema).
  if (typeof message.reply_to === "number") {
    const ref = state.messagesById.get(message.reply_to);
    const context = document.createElement("div");
    context.className = "reply-context";
    context.textContent = ref
      ? `↩ ${ref.from}: ${replySnippet(ref.text)}`
      : `↩ replying to #${message.reply_to}`;
    bubble.append(context);
  }
  bubble.append(text);

  if (!restoredRow) item.addEventListener("dblclick", () => setReply(message));
  item.dataset.senderKind = senderKind;
  item.append(avatar, bubble);
  place(item);
}

function labelFor(alias) {
  return state.participantLabels.get(alias) || alias;
}

// One-line, plain-text preview of a replied-to message body for the composer
// indicator and the timeline reply context (never rendered as markdown).
function replySnippet(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function setReply(message) {
  state.replyTo = message.id;
  clearPendingSendIfTextChanged();
  replyIndicator.hidden = false;
  replyIndicatorLabel.textContent = `Replying to ${labelFor(message.from)} #${message.id}`;
  messageText.focus();
}

// Clear the pending reply before send (button, or Escape in the composer). The
// message being replied to is unchanged; only the composer's reply target drops.
function clearReply() {
  if (state.replyTo === null) return;
  state.replyTo = null;
  clearPendingSendIfTextChanged();
  replyIndicator.hidden = true;
  replyIndicatorLabel.textContent = "";
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
  // Host unreachable (not closed) → read-only local-backup mode (#211): the
  // composer is disabled and the timeline is an honest device-local snapshot.
  const offline = !closed && state.connection === "degraded";
  shell.dataset.state = closed ? "closed" : offline ? "backup" : "open";
  composer.hidden = closed;
  setComposerDisabled(closed || state.sendInFlight || offline);
  renderBanner(closed);
  renderSession(closed);
  renderHistoryStrip(closed);
  // Older history is host-held, so the route to it follows the same reachability
  // this function already reconciles for everything else (#283).
  renderEarlierControl();
  // Honest read-only backup notice (#211): name the device-local snapshot + its
  // cursor so the offline view never implies complete/unseen history, and state
  // that sending is paused until the host resumes.
  if (backupNotice !== null) {
    backupNotice.hidden = !offline;
    if (offline) {
      // #297: when older rows fetched FROM THE HOST (#283) are also on screen, the
      // notice must name both sources. It was never wrong — its stated bound is
      // the upper one and still holds, and the provenance divider below already
      // says where those rows came from — but it described one source as though
      // it were the whole timeline, in the label next to the one #283 exists to
      // keep honest.
      //
      // Where no host-fetched rows exist the text is byte-for-byte what it has
      // always been: a notice that hedges in every state is worse than one that
      // is partial in a rare one. The operative clause — newer messages aren't
      // shown and can't be sent — is carried verbatim into every branch, because
      // it is why the notice exists at all.
      //
      // THREE reachable states, not four (@re2, msg 1418; ruled by @head). An
      // empty backup with host-fetched rows cannot occur: the fetch loop puts
      // every id it renders into `state.seen` before `state.earlier.loaded` is
      // incremented, so `loaded > 0` implies `seen.size > 0`. A branch for it
      // would be a string that can never render — worse than absent, because it
      // reads as handled behaviour and the only test able to reach it would have
      // to fabricate state and would prove nothing.
      const fetchedFromHost = state.earlier.loaded > 0;
      const older = `${state.earlier.loaded} older ${state.earlier.loaded === 1 ? "message" : "messages"} fetched from the host while it was reachable`;
      backupNotice.textContent =
        state.seen.size > 0
          ? fetchedFromHost
            ? `Local backup + host history · the host server is offline. Showing ${older}, and messages saved on this device up to #${state.backupCursor}; newer messages aren't shown and can't be sent until the host resumes.`
            : `Local backup · the host server is offline. Showing messages saved on this device up to #${state.backupCursor}; newer messages aren't shown and can't be sent until the host resumes.`
          : "Local backup · the host server is offline. No messages are saved on this device yet; new messages can't be sent until the host resumes.";
    }
  }
}

// Active chat session surface (#183 / V2 T12): everyone sees the accent banner
// while a session runs; the host also gets the start/end toggle (the toggle lives
// inside #host-controls, so it is already gated to hosts). A closed room clears
// the session server-side, so this collapses back to the idle look.
function renderSession(closed) {
  const session = closed ? null : state.activeSession;
  if (session) {
    const channel = session.channel_id || "general";
    const elapsed = Math.max(0, Math.round((Date.now() - Date.parse(session.started_at)) / 60000));
    const expected = session.expected_duration_m;
    const policy = session.requested_mode ? ` · attendance ${session.requested_mode}` : "";
    sessionTitle.textContent = `Active session in #${channel}`;
    sessionDetail.textContent = `${elapsed}m elapsed · ~${expected}m expected${policy}`;
    sessionBanner.hidden = false;
  } else {
    sessionBanner.hidden = true;
  }
  // The host can start a session only while the room is open; a closed room hides
  // the control entirely (no fabricated affordance).
  sessionControl.hidden = closed;
  sessionToggle.dataset.mode = session ? "end" : "start";
  sessionToggle.textContent = session ? "end session" : "start session";
}

function renderBanner(closed) {
  if (closed || state.connection === "live") {
    roomBanner.hidden = true;
    return;
  }
  if (state.connection === "degraded") {
    roomBanner.dataset.kind = "degraded";
    bannerTitle.textContent = "Host offline — local backup";
    const reason = state.connectionCode ? ` (${state.connectionCode})` : "";
    bannerDetail.textContent = `the host server isn't responding${reason}. You're viewing a read-only local backup; new messages can't be sent until the host resumes.`;
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
    // Source-state label (#211): live from host vs local snapshot when offline.
    historyKv.textContent = state.connection === "degraded" ? "local snapshot · host offline" : "live from host";
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
