# Telegent Founding Tickets

Status: GitHub issue source of truth after repository creation
Date: 2026-06-21
Product: Telegent

These drafts are the founding issue source material for
`realproject7/telegent`. GitHub issue bodies are the implementation source of
truth; amend issue bodies directly when scope changes, then mirror durable
founding changes back here when useful.

## Labels

- `epic`
- `agent/claude`
- `agent/quadwork`
- `open-design`
- `gate`
- `follow-up`
- `bug`
- `enhancement`

## Ticket Review Rule

Before implementation starts:

1. Create the EPIC and sub-tickets.
2. Run a ticket review pass against the proposal and the scaffolded repo paths.
3. Fix issue bodies for missing context, bad paths, unclear scope, over-broad
   work, stub risk, and over-engineering risk.
4. Only then implement.

No implementation ticket may allow mock, stub, placeholder, or temporary runtime
code. Test fixtures are allowed only when explicitly named as fixtures and are
not used as product behavior.

## Routing Plan

- Direct agent (`agent/claude`): repo founding, browser-room UX decisions,
  end-to-end dogfood, local machine verification, and operator-facing docs.
- QuadWork (`agent/quadwork`): headless, fixture-testable Node/TypeScript work
  such as storage, protocol validation, HTTP API, CLI commands, and tests.
- Open Design (`open-design`): only if the operator wants a polished product
  design package before implementation. For MVP, a compact `tokens.css` and
  browser-room reference screen are enough.

## Source Documents

- `docs/PROPOSAL.md`
- `docs/FOUNDING-TICKETS.md`
- PO workflow source: `/Users/cho/Projects/docs/MANUAL-po-agent-workflow.md`
- `/Users/cho/Projects/docs/telegent-quadwork-review-notes-codex.md`
- `/Users/cho/Projects/docs/telegent-quadwork-edits-opus.md`
- `/Users/cho/Projects/telegent-lite/server.js`

## EPIC: Build Telegent v0.1

### Goal

Build Telegent v0.1: a lightweight, host-controlled temporary room protocol
that lets trusted agent sessions and humans exchange chat messages through a
local room server, versioned room briefs, participant-specific attend cards, an
agent-friendly CLI, and a static browser room.

### Product Boundaries

Telegent v0.1 includes host-created temporary rooms, localhost local
participants, a remote-auth-ready endpoint model, agent and human participant
roles, room-scoped aliases, append-only chat logs,
participant cursors, long-poll `/wait`, JSON output for agents, embed-first
handoff with size limits, room briefs, participant-specific attend cards,
browser room support, and room export.

Telegent v0.1 excludes central cloud message storage, persistent whitelist
networks, automatic command execution, default XMTP dependency, paid tunnel
routing, x402 payments, durable installed supervision, MCP adapters, and
QuadWork-style PTY wake injection.

### Architecture Summary

One host starts a room server. The server owns the room manifest, participant
manifest, current `brief.md`, append-only `messages.jsonl`, cursors, and HTTP
API. The room manifest stores `brief_version`, `brief_updated_at`, and
`brief_updated_by`. Participants join through room-scoped aliases and
credentials. Local participants use localhost.
The MVP is remote-auth-ready through participant tokens, fragment-token browser
admission, and the TLS rule, but the remote exposure transport itself is
post-MVP Backlog A. Agents can attend through `/wait` long-polling, and humans
can use the static browser room served by the same process.

### Design Concept

Design concept: **Operator Chat Console**.

Hard rules:

- Chat is the primary surface; diagnostics never dominate the message timeline.
- The UI is quiet, dense, and utilitarian rather than marketing-like.
- Participant identity is explicit: alias, kind, location, installation, and
  observed attention state are visible in the roster.
- Host-only destructive controls are clearly separated and never appear for
  guest participants.
- Untrusted message content is rendered safely with `textContent` and explicit
  DOM construction, never untrusted `innerHTML`.

### MVP Scope

- repository scaffold and releaseable CLI package
- room and participant manifests
- safe slug validation for room IDs and aliases
- append-only `messages.jsonl`, writer lock, and startup recovery
- HTTP API: `/`, `/card`, `/join`, `/messages`, `/wait`, `/leave`, `/close`,
  `/status`
- HTTP brief API: `/brief`
- authentication and sender binding
- long-poll `/wait` heartbeat and room-closed behavior
- CLI room lifecycle and messaging commands
- versioned room brief
- participant-specific attend cards with curl commands
- embed-first handoff with size limits
- static vanilla browser room at `GET /`
- safe browser rendering and fragment-token join flow
- room export and local diagnostics
- end-to-end dogfood with two local agents and one human browser participant

### Acceptance Criteria

- Two local agent sessions can join one room and exchange messages.
- A no-install participant can use a card, attend through `/wait`, and reply
  through curl without installing the CLI.
- A participant can read the room brief from its Attend Card and through
  `/brief`.
- A human can open the browser room, read messages, send messages, inspect the
  roster, and export the room.
- Closing the room stops message delivery and returns a clear room-closed
  response to `/wait`.
- Sender identity is derived from the authenticated participant token, never
  from client-supplied `from`.
- Mention parsing only resolves current participant aliases and ignores fenced
  code blocks and inline code spans.
- Any non-localhost exposure requires TLS or another secure tunnel.
- Localhost write endpoints are protected by same-origin checks or a host-local
  session token.
- Browser rendering never evaluates untrusted message content.
- No mock, stub, placeholder, or temporary runtime code exists.

### Sub-Ticket Checklist

- [ ] Ticket 1: Scaffold repo, package, CLI entrypoint, and quality gates
- [ ] Ticket 2: Define room storage, protocol objects, validation, and log writer
- [ ] Ticket 3A: Implement host room HTTP API core and security contract
- [ ] Ticket 3B: Implement `/wait`, TTL auto-close, and lifecycle delivery
- [ ] Ticket 4: Implement room lifecycle CLI commands
- [ ] Ticket 5: Implement agent messaging CLI, `/wait` attendance, and handoff
- [ ] Ticket 6: Implement static browser room shell and safe chat UX
- [ ] Ticket 7: Implement roster, human controls, export, and diagnostics
- [ ] Ticket 8: Add end-to-end dogfood tests and acceptance fixtures
- [ ] Ticket 9: Write public docs, security notes, and operator runbook
- [ ] Backlog A: Secure remote exposure guides and telegent.dev tunnel spike
- [ ] Backlog B: Core participant supervision and installed watcher
- [ ] Backlog C: Optional XMTP and x402 research spikes

## Ticket 1: Scaffold repo, package, CLI entrypoint, and quality gates

### Goal

Create the real `telegent` repository skeleton so all later tickets have
verified paths, test commands, and package boundaries.

### Where

- Repo root: `.`
- Operator local checkout: `/Users/cho/Projects/telegent/`
- QuadWork VPS checkout: `~/telegent/`
- Reference prototype: `/Users/cho/Projects/telegent-lite/server.js` (operator-local dogfood reference only; do not import from it)
- Source proposal: `docs/PROPOSAL.md`

### Scope

- Create a Node/TypeScript CLI package named `telegent`.
- Add executable CLI entrypoint for `telegent`.
- Add source, test, docs, and fixture directories.
- Add lint, typecheck, test, and no-stub scripts.
- Add README, LICENSE, SECURITY.md, `.gitignore`, and package metadata.
- Copy `/Users/cho/Projects/docs/PROPOSAL-telegent.md` into the repo as
  `docs/PROPOSAL.md`; later tickets must reference this committed in-repo copy.
- Add a minimal command router that can print help and version.

### Acceptance Criteria

- `telegent --help` works from the local package.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm no-stub` exist and run.
- The repo contains no mock, stub, placeholder, or temporary runtime code.
- `docs/PROPOSAL.md` exists in the repo and matches the source proposal used for
  founding.
- All later tickets can replace planned paths with verified paths from this
  scaffold.

### Routing

`agent/claude`: repo founding and local package verification should happen on
the operator's machine before delegating headless work.

## Ticket 2: Define room storage, protocol objects, brief model, validation, and log writer

Depends on: repository scaffold from Ticket 1.

### Goal

Implement the durable local data model that makes a Telegent room safe,
recoverable, and easy for agents to inspect.

### Where

- Repo path: `src/protocol/`
- Repo path: `src/storage/`
- Repo path: `test/fixtures/`
- Reference: `/Users/cho/Projects/telegent-lite/server.js` (operator-local dogfood reference only; do not import from it)
- In-repo proposal copy: `docs/PROPOSAL.md`,
  sections §9, especially §9.4 Room Brief, §10, §12.1-§12.4

### Scope

- Define Room, Participant, Invite, RoomBrief, Message, WaitResponse, and error
  objects.
- Implement product source as TypeScript `.ts` files. Static browser assets in
  later tickets may use `.html`, `.css`, and `.js`, but runtime CLI/server
  source should not be written as loose JavaScript.
- Enforce safe slug validation for room IDs and aliases: lowercase
  `[a-z0-9-]`, no dots, no separators, no traversal.
- Implement room directory layout under `~/.telegent/rooms/<room>/`.
- Store the current brief body in `brief.md`.
- Implement append-only `messages.jsonl` writes with monotonic message IDs.
- Add writer lock with stale-process liveness check.
- Recover the next message ID from `messages.jsonl` on startup.
- Store participant cursors separately from message history.
- Track `brief_version`, `brief_updated_at`, and `brief_updated_by` in room
  state.
- Implement a pure mention parser that accepts message text plus a participant
  roster and returns resolved aliases while ignoring fenced code blocks and
  inline code spans.

### Acceptance Criteria

- Unit tests cover valid and invalid room IDs and aliases.
- Concurrent append tests cannot produce duplicate IDs or malformed JSONL.
- Startup recovery continues from the highest existing message ID.
- Brief update tests prove version increments and room metadata changes without
  introducing a structured workflow object or separate brief-history store.
- Brief body size is capped so a large brief cannot bloat `/card` responses or
  fill the host disk.
- Mention tests cover normal mentions, unknown aliases, inline code, and fenced
  code blocks.
- Client-supplied fields are whitelisted; server-assigned fields cannot be
  overridden by request bodies.

### Routing

`agent/quadwork`: pure Node/TypeScript storage and validation work is headless
and fixture-testable.

## Ticket 3A: Implement host room HTTP API core and security contract

Depends on: #3.

### Goal

Expose the room as a host-run HTTP API that agents, curl participants, the CLI,
and the browser room can all use safely, excluding the specialized `/wait`
long-poll lifecycle handled in Ticket 3B.

### Where

- Repo path: `src/server/`
- Repo path: `src/auth/`
- Repo path: `test/server/`
- Extend existing CLI-independent TypeScript source; do not introduce loose
  runtime `.js` server code.
- In-repo proposal copy: `docs/PROPOSAL.md`,
  sections §9.4, §11.1, §12.1-§12.6, §12.8, §13, §15.1

### Scope

- Serve `GET /` as the static browser room shell.
- Provide a stable server asset lookup for `GET /`; Ticket 6 owns the static
  browser files and build-copy packaging that makes those assets available from
  the installed package.
- Implement `/brief`, `/card`, `/join`, `/messages`, `/leave`, `/close`, and
  `/status`.
- Bind sender identity from the authenticated token or host-local session,
  never from client body fields.
- At message append time, call the Ticket 2 mention parser with the live
  participant roster so mentions resolve against current room membership.
- Return the flat standard error contract:
  `{ "ok": false, "error": "code", "message": "human-readable reason" }`.
- Require TLS or another secure tunnel for any non-localhost exposure.
- Protect localhost write endpoints with same-origin Origin/Referer checks or a
  host-local session token.
- Add rate limits, max body size, and room-log cap guards.
- Render `/card` as a participant-specific Attend Card that includes the current
  Room Brief plus alias, token handling, send/read/wait commands, and safety
  rules.
- Include `brief_version`, `brief_updated_at`, and `brief_updated_by` in
  `/status?json`.
- Allow only the host to update `/brief`; this endpoint is the server
  single-writer path used by `telegent room brief set` when the room server is
  running. Each update increments the brief version.
- Append lifecycle `system` messages for join, leave, close, remove, and TTL
  close events.
- Append a `system` message when the brief changes so attending participants can
  reload context.
- Add server-side loop guard behavior that resets on human messages and protects
  all participants, including curl/no-install participants.

### Acceptance Criteria

- API integration tests cover every non-`/wait` endpoint.
- Auth tests prove one participant cannot spoof another participant's `from`.
- `/brief` tests cover read access, host-only update access, version increment,
  and system-message emission.
- `/card` tests prove the current brief is included and the card is rendered
  with participant-specific alias and commands.
- Oversized brief updates are rejected with the standard error contract.
- Plain HTTP exposure beyond localhost is rejected or requires an explicit
  secure-tunnel mode.
- Localhost CSRF tests cannot write messages from an untrusted origin.
- Lifecycle system messages are appended for join, leave, close, remove, and
  TTL close events and brief updates.
- Loop guard tests prove a curl participant cannot trigger unbounded agent loops.

### Routing

`agent/quadwork`: HTTP server and security contract are headless and can be
tested with integration fixtures.

## Ticket 3B: Implement `/wait`, TTL auto-close, and lifecycle delivery

Depends on: #3.

### Goal

Implement the long-poll attendance primitive that lets no-install agents stay in
the room without push infrastructure.

### Where

- Repo path: `src/server/wait.ts`
- Repo path: `test/server/wait.test.ts`
- Implement as TypeScript `.ts`; do not add loose runtime `.js` server files.
- In-repo proposal copy: `docs/PROPOSAL.md`,
  sections §8.3, §9.6, §12.5, §12.7, §12.8, §13.6

### Scope

- Implement `/wait` long-poll hold with a maximum hold of roughly 25 seconds.
- Return immediately when a new message arrives, the participant is removed, or
  the room closes.
- Return heartbeat responses with `keep_waiting: true` and a usable `next_cmd`.
- Preserve `since_id` as an exclusive lower bound.
- Enforce room TTL auto-close when `now >= expires_at`.
- On TTL close, set room status to closed, append a lifecycle `system` message,
  and release all waiters with `room_status: "closed"` and `keep_waiting:
  false`.
- Use fake-clock or deterministic timer fixtures for hold and TTL tests.

### Acceptance Criteria

- `/wait` returns new messages immediately without waiting for the heartbeat
  timeout.
- Heartbeat responses contain enough information for an agent to continue
  attending without reading a separate manual.
- Room close and TTL close release waiters cleanly.
- Removed participants receive the reserved removed-participant response.
- Tests prove `since_id` is exclusive and timer behavior is deterministic.

### Routing

`agent/quadwork`: `/wait` is headless but timing-sensitive, so it should have
isolated fake-clock tests and a focused review.

## Ticket 4: Implement room lifecycle CLI commands

Depends on: #3 and #4.

### Goal

Give the host and participants a small, predictable CLI for creating, joining,
leaving, inspecting, and closing rooms.

### Where

- Repo path: `src/cli/`
- Repo path: `src/cli/commands/room/`
- Extend the existing CLI router in `src/cli/index.ts` and help text in
  `src/cli/help.ts`.
- In-repo proposal copy: `docs/PROPOSAL.md`,
  sections §8.1, §8.2, §9.3, §17 Phase 1

### Scope

- Implement CLI command source as TypeScript `.ts` files under
  `src/cli/commands/<area>/`.
- Implement `telegent room start`.
- Implement `telegent room brief set` and `telegent room brief view`.
- Implement `telegent room serve`.
- Implement `telegent room invite` and `telegent room invite-card`.
- Implement `telegent room join`, `current`, `leave`, and `close`.
- Implement `telegent room dashboard` to open the static browser room URL.
- Emit agent-friendly text by default and stable JSON with `--json`.
- Generate no-install cards with exact curl commands for `/card`, `/wait`, and
  `/messages`.
- Ensure `telegent room invite-card` renders the current Room Brief as part of
  the participant-specific Attend Card.
- Enforce short-TTL single-use admission tokens for card flows.

### Acceptance Criteria

- CLI tests cover happy path and invalid room/alias inputs.
- `--json` output is stable enough for agents to parse.
- Invite cards never instruct participants to rely on client-supplied `from`.
- `room brief set` increments the brief version and causes attending
  participants to see a brief-updated system message.
- `telegent room dashboard` opens the same URL served by `room serve`; no
  separate `serve-dashboard` process or port exists.
- Closing a room updates local state and causes `/wait` clients to exit cleanly.

### Routing

`agent/quadwork`: CLI behavior is headless and can be tested against temporary
home directories and HTTP fixtures.

## Ticket 5: Implement agent messaging CLI, `/wait` attendance, and handoff

Depends on: #4 and #5.

### Goal

Make Telegent useful from inside agent sessions by providing simple messaging,
reading, attendance, reply, and handoff commands.

### Where

- Repo path: `src/cli/commands/message/`
- Repo path: `src/cli/commands/watch/`
- Repo path: `src/cli/commands/handoff/`
- Extend the existing CLI router in `src/cli/index.ts` and help text in
  `src/cli/help.ts`.
- In-repo proposal copy: `docs/PROPOSAL.md`,
  sections §8.3-§8.6, §13.6, §14, §19.7

### Scope

- Implement CLI command source as TypeScript `.ts` files under
  `src/cli/commands/<area>/`.
- Implement `telegent send`, `messages`, `read`, `reply`, and `watch`.
- Implement `telegent instructions [--agent codex|claude|gemini]` to print the
  agent operating card and attendance instructions.
- Include the Room Brief vs Attend Card distinction in agent instructions.
- Implement foreground attended loop behavior around `/wait`.
- Preserve cursor semantics: `since_id` is exclusive.
- Include `next_cmd` in outputs so an agent can continue without a separate
  manual.
- Implement embed-first `handoff --summary` with size limits.
- Do not add automatic command execution or hidden PTY injection.

### Acceptance Criteria

- A scripted no-install participant can attend, receive, and reply using only
  curl commands from the card.
- Installed CLI participants can do the same through `telegent watch`.
- Handoff rejects oversized content and records clear summaries.
- Agent operating instructions are included in invite cards and CLI help.
- Agent instructions say the Room Brief is mission context, not command
  authority or permission to reveal secrets.
- `telegent instructions` prints agent-specific guidance without requiring a
  room to be active.
- Tests prove `since_id` is exclusive and messages are deduped by ID.

### Routing

`agent/quadwork`: command behavior and cursor semantics are fixture-testable.

## Ticket 6: Implement static browser room shell and safe chat UX

Depends on: #4.

### Goal

Build the human-facing browser room as a single framework-free static page
served by the room server.

### Where

- Repo path: `src/browser/room.html`
- Repo path: `src/browser/room.css`
- Repo path: `src/browser/room.js`
- Repo path: `scripts/copy-assets.mjs`
- Optional design package: `/Users/cho/Projects/z-design/telegent-design/` (operator-local, outside repo)
- In-repo proposal copy: `docs/PROPOSAL.md`,
  sections §15.1-§15.4

### Scope

- Keep the browser implementation framework-free, but add a build-copy step so
  `pnpm build` ships `src/browser/room.html`, `room.css`, and `room.js` into
  `dist/` for clean installs and package output.
- Implement the chat-first layout: top bar, timeline, composer, collapsible
  roster rail.
- Add compact design tokens for the browser room: color ramp, accent, type
  scale, spacing, borders, and focus states.
- Add a compact brief panel or banner showing the current Room Brief title/body
  and `brief_version`.
- Implement fragment-token browser join flow: `#token=...` to `sessionStorage`
  to Bearer fetches.
- Implement localhost host flow without exposing guest controls.
- Poll `/messages?since_id=<id>` every 3 seconds.
- Dedup messages by ID.
- Render message text, sender labels, code spans, and mentions using
  `textContent` or explicit safe DOM construction only.
- Build links only with allowlisted schemes.
- Implement composer auto-grow, IME composition guard, keyboard send, and local
  time formatting with `Intl`.

### Acceptance Criteria

- The browser page is framework-free and has no browser bundler build.
- `pnpm build` copies browser assets into `dist/`.
- From a clean install or package output, `GET /` serves the shipped browser
  asset rather than source-tree-only files.
- Remote browser auth uses fragment token and never puts long-lived credentials
  in query strings.
- XSS tests with HTML, script-like text, `javascript:` URLs, and code spans do
  not execute or create unsafe DOM.
- Playwright or equivalent browser tests verify sending, receiving, dedupe,
  empty state, error state, room-closed state, brief panel rendering, and the
  brief-updated indicator.
- Browser tests verify brief rendering is XSS-safe and does not use untrusted
  `innerHTML`.
- UI text does not overlap at desktop and narrow mobile widths.

### Routing

`agent/claude`: frontend UX is operator-sensitive and should be verified with a
real browser screenshot pass on this machine, even though the implementation is
static.

## Ticket 7: Implement roster, human controls, export, and diagnostics

Depends on: #4 and #8.

### Goal

Give human participants enough visibility and control to use Telegent like a
temporary chat room without turning it into a heavy orchestrator.

### Where

- Repo path: `src/browser/`
- Repo path: `src/cli/commands/export/`
- Repo path: `src/cli/commands/doctor/`
- Extend the existing CLI router in `src/cli/index.ts` and help text in
  `src/cli/help.ts`.
- In-repo proposal copy: `docs/PROPOSAL.md`,
  sections §7, §15.3-§15.5, §16, §17 Phase 2

### Scope

- Implement CLI command source as TypeScript `.ts` files under
  `src/cli/commands/<area>/`.
- Render roster fields: alias, kind, location, install, attention, last seen.
- Show observed state, not host-decreed mode.
- Show a visible brief-updated indicator when `/status?json` reports a newer
  `brief_version` than the browser has rendered.
- Add host-only close and export controls.
- Add system-message filter.
- Add room export command and browser export affordance.
- Add `telegent doctor` for local port, storage, lock, token, and room status
  checks.
- Add dead-letter or error display for failed sends.

### Acceptance Criteria

- Host controls are hidden or disabled for non-host participants.
- Roster state updates from `/status` without reloading the page.
- Brief version state updates from `/status` without reloading the page, and the
  user can re-open or refresh the brief panel.
- Export produces a readable room artifact and does not mutate the source log.
- `telegent doctor` reports actionable failures without dumping secrets.
- Diagnostics do not dominate the chat timeline.

### Routing

Mixed: `agent/quadwork` for export and doctor command logic; `agent/claude` for
browser control placement and visual verification.

## Ticket 8: Add end-to-end dogfood tests and acceptance fixtures

Depends on: #4, #5, #6, #7, and #8.

### Goal

Prove the MVP works through the exact collaboration pattern that motivated the
product: multiple agents and a human in one temporary room.

### Where

- Repo path: `test/e2e/`
- Repo path: `docs/dogfood/`
- Test helpers should use TypeScript `.ts` where they compile with the project;
  static fixtures may remain plain data files.
- Current dogfood logs: `/Users/cho/.telegent-lite/rooms/` (operator-local references only; sanitize before copying fixtures)
- In-repo proposal copy: `docs/PROPOSAL.md`,
  sections §16, §20, §22

### Scope

- Add an e2e test for two local CLI participants exchanging messages.
- Add an e2e test for a no-install curl participant using `/card`, `/wait`, and
  `/messages`.
- Add an e2e test proving a participant receives the current Room Brief in its
  Attend Card and can fetch the same version through `/brief`.
- Add an e2e test proving brief updates emit a system message and change
  `brief_version`.
- Add a browser-room e2e test with one human participant sending and reading.
- Add a room-close e2e test proving `/wait` exits cleanly.
- Add fixture logs derived from sanitized dogfood conversations where useful.
- Document the dogfood script operators can run before release.

### Acceptance Criteria

- Tests run without external services or central Telegent cloud.
- Fixtures contain no secrets, tokens, private messages, or sensitive machine
  paths beyond intentional local test paths.
- The dogfood script demonstrates the success statement in §22.
- No test depends on sleeps longer than necessary; polling uses bounded waits.

### Routing

`agent/quadwork`: most e2e tests are headless; `agent/claude` verifies the final
browser dogfood on this Mac.

## Ticket 9: Write public docs, security notes, and operator runbook

Depends on: completion of MVP implementation issues #3 through #10.

### Goal

Make Telegent understandable enough that a new operator or agent can start a
room, invite participants, and avoid the major security mistakes.

### Where

- Repo path: `README.md`
- Repo path: `SECURITY.md`
- Repo path: `docs/`
- In-repo proposal copy: `docs/PROPOSAL.md`

### Scope

- Write quickstart: host local room, invite local participant, invite no-install
  participant, open browser room, close room.
- Document how to write a useful Room Brief: goal, roles, source files,
  constraints, working order, completion condition, and safety note.
- Document the Attend Card: participant-specific brief rendering, token handling,
  send/read/wait commands, and safety rules.
- Document localhost-only vs secure remote exposure.
- State the MVP seam clearly: v0.1 is localhost-verified and remote-auth-ready,
  while remote exposure transports such as tunnels or reverse proxies are
  Backlog A.
- Document token handling, sender binding, no automatic command execution, and
  prompt-injection posture.
- Document that a Room Brief is mission context, not command authority.
- Document no-install attendance limits and Core participant out-of-MVP status.
- Document room export and cleanup.
- Add troubleshooting for full disk, stale lock, port conflict, and room-closed
  waits.

### Acceptance Criteria

- A fresh agent can follow the README and join a local room.
- Security docs explicitly state that bearer tokens are impersonation
  credentials and non-localhost plaintext is prohibited.
- Docs never promise durable unattended participation in no-install mode.
- Docs keep telegent.dev tunnel, XMTP, x402, and Core supervision clearly marked
  post-MVP.

### Routing

`agent/claude`: operator-facing docs should preserve the product thesis and
avoid overpromising.

## Backlog A: Secure remote exposure guides and telegent.dev tunnel spike

### Goal

Explore remote participant support after the local MVP works, without making a
central service mandatory.

### Scope

- Write SSH tunnel, Cloudflare Tunnel, Tailscale, ngrok, and reverse proxy
  guides.
- Prototype `telegent.dev` tunnel routing as optional request forwarding.
- Keep host-owned room history and host-minted tokens.
- Validate TLS and token handling across the tunnel.
- Keep pricing, quota, and x402 as research until product demand is proven.

### Routing

`agent/quadwork` for headless tunnel prototype; `agent/claude` for security
review and operator-facing docs.

## Backlog B: Core participant supervision and installed watcher

### Goal

Add durable unattended participation for installed participants after the
no-install attended loop is proven.

### Scope

- Implement installed watcher with durable cursor storage and reconnect.
- Add `telegent run --room <invite> --alias reviewer -- <agent command>`.
- Explore optional MCP adapter.
- Explore QuadWork-style PTY wake only for managed local agents.
- Inject wake pointers only; never inject full message payloads into PTYs.

### Routing

Mixed: `agent/quadwork` for watcher state and reconnect logic; `agent/claude`
for PTY behavior and local safety review.

## Backlog C: Optional XMTP and x402 research spikes

### Goal

Keep network/payment ideas available without distracting from v0.1.

### Scope

- Evaluate XMTP as an optional encrypted room transport.
- Evaluate x402 for tunnel routing payments and paid agent requests.
- Keep payment policy explicit with daily caps, per-request caps, and
  confirmation thresholds.
- Keep XMTP and x402 disabled by default.

### Routing

`agent/claude`: research spikes need product judgment and updated current
external information before implementation.
