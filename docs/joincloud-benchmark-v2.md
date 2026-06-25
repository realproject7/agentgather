# Agent Gather V2 Benchmark: Join.cloud

Date: 2026-06-25
Issue: #137
Benchmark target: https://join.cloud/docs
Test room: `ag-v2-bench-1782362125621`
Room UUID: `3e0e304b-85c1-4887-956c-219e8702387d`

## Executive Summary

Join.cloud validates several Agent Gather V2 assumptions: room-scoped participant tokens, reconnect by token, unread/history APIs, SSE as a lightweight realtime fallback, and explicit room limits are useful primitives for agent collaboration. However, Join.cloud is still primarily agent-room infrastructure, not a human-plus-agent project boardroom product. It centralizes room messages and git storage, exposes room UUIDs as bearer tokens, and its public docs/browser/git paths showed rough edges during the test. Agent Gather should adopt the clean protocol ideas, adapt room lifecycle and quota semantics to the host-owned/local-first model, and avoid copying central message-body storage as the canonical source.

Recommendation: T3 should proceed, with adjustments. Add boardroom/channel identity and history APIs inspired by Join.cloud, but keep Agent Gather's host-owned SSOT and platform metadata/content separation.

## What Was Tested

Public docs and live HTTP/A2A calls were tested without credentials or paid payment. No MCP client was installed into Claude/Codex because the public docs were enough to validate the protocol surface, and the spike was intended to avoid tool-environment churn.

Validated successfully:

- `room.create`
- `room.join`
- `message.send`
- `message.history`
- `message.unread`
- `room.info`
- reconnect with the same `agentToken`
- duplicate-name rejection without the original token
- direct message (`to`) visibility in unread/history
- `room.leave`
- SSE receive path
- tiers endpoint
- upgrade endpoint behavior when payment is disabled

Observed issues/limits:

- A2A docs require careful mapping: `roomId` maps to `message.contextId`, not `metadata.roomId`.
- Browser path `https://join.cloud/<room-name>` returned docs text during this test, not a usable human room UI.
- Git Smart HTTP returned `Git backend unavailable` for the created room.
- `/.well-known/agent-card.json` returned localhost URLs in `url` and `documentationUrl`, which is likely a deployment metadata bug.
- `GET /api/tiers` returned `paymentEnabled:false`; `POST /api/upgrade/:roomId/basic` succeeded without payment and upgraded the room, so x402 was inspectable only as documented behavior, not as a live paid flow.

## Key Findings

### 1. Room-scoped participant tokens are the right primitive

`room.join` returns an `agentToken`. The token is used for message send/history/unread/leave, and passing it back to `room.join` reconnects the same participant name. Joining with an already-taken name without the token is rejected.

Agent Gather implication:

- Keep participant/invite tokens first-class.
- Add explicit reconnect semantics to V2 participant identity.
- Distinguish `displayName` from stable participant identity.
- For local-first boardrooms, keep the token private and do not store raw invite URLs or participant tokens in the central control plane.

### 2. Unread is more useful than pure history polling

Join.cloud has both `message.history` and `message.unread`. `message.unread` returns messages since that participant's last read position and marks them read.

Agent Gather implication:

- Add read cursor semantics to V2 channels.
- Prefer `unread` as the normal idle/boardroom mode primitive.
- Keep `/wait` or SSE for active chat sessions, but do not force active listening as the default collaboration mode.

### 3. SSE is a good lightweight active-mode option, but not a detached wake solution

The SSE endpoint delivered a message event successfully with `curl -N`. This is simpler than custom long-poll loops and useful for attended active mode.

Agent Gather implication:

- Consider adding `/events` SSE alongside existing `/wait` for active chat sessions.
- Keep `/wait` for curl compatibility and environments where SSE handling is awkward.
- Do not present SSE as a way to wake a detached external agent. It still requires the participant process/session to hold a connection.

### 4. A2A push requires the participant to expose an endpoint

Join.cloud supports `agentEndpoint` on join, where the server POSTs events to the agent. This is a clean protocol for custom agents, but it only works when the participant can expose an HTTP endpoint reachable by the server.

Agent Gather implication:

- This should be a later `managed/core` integration, not the no-install baseline.
- For no-install external agents, keep Attend Cards and heartbeat/wake-on-event wrappers.
- For installed adapters, A2A-style callback endpoints are worth adopting.

### 5. Central room history is convenient but conflicts with Agent Gather's privacy bet

Join.cloud stores message history centrally with rolling limits and room TTL. This is ergonomic but not the Agent Gather promise.

Agent Gather implication:

- The central service should store boardroom/project/channel metadata, participant roster, route health, quotas, and unread indexes when safe.
- It should not store canonical message bodies, forum post bodies, room brief bodies, bearer tokens, or invite URLs by default.
- Host-owned files remain SSOT for content. Participant-local cache can improve offline UX but must be clearly labeled as cache/snapshot.

### 6. Explicit limits and lifecycle vocabulary are useful

Join.cloud's free tier has concrete limits: rolling message history, git storage, idle TTL, and plan expiration/grace behavior.

Agent Gather implication:

- V2 should define boardroom statuses and limits in product language early: `active`, `idle`, `inactive`, `removed`.
- Public routing quota should be visible as route-hours / bandwidth / public-room uptime, not hidden infrastructure.
- If paid tiers arrive, keep the unit simple and visible.

### 7. Git-backed collaboration is adjacent, not core

Join.cloud positions git as the file collaboration channel. The live `git ls-remote` test returned `Git backend unavailable`, so the implementation could not be validated in this run.

Agent Gather implication:

- Do not make git-backed room content part of V2 core.
- Keep optional export/worktree integration as a later enhancement.
- For development workflows, GitHub/QuadWork remains the real implementation system; Agent Gather is the human/agent coordination boardroom.

### 8. Browser human UX is Join.cloud's weak spot from this test

The docs claim browsers can view rooms at `https://join.cloud/<room-name>`, but the tested path returned the docs content instead of a room UI.

Agent Gather implication:

- Human browser UX is a differentiator. V2 should prioritize a polished boardroom UI, channel list, forum views, readable history snapshots, and clear online/offline states.
- Do not treat HTTP protocol completeness as enough; humans need a real product surface.

## Adopt / Adapt / Avoid

### Adopt

- Participant `agentToken` reconnect model.
- Duplicate display-name rejection unless token proves ownership.
- `message.history` plus `message.unread` split.
- SSE as an active-mode receive path.
- Explicit `room.info` shape with participant roster and limits.
- Simple `to` field for DM/private delivery semantics.
- Public capability discovery idea (`/.well-known/agent-card.json`), but fix deployment correctness.

### Adapt

- A2A callback endpoints: support later for managed/core participants, not no-install MVP.
- Room lifecycle limits: adapt to boardroom/channel statuses and public-routing quotas.
- x402 upgrades: keep as experimental after ordinary billing is stable; expose payment-disabled/dev modes clearly.
- Git collaboration: adapt as optional export/worktree integration, not canonical boardroom content.

### Avoid

- Central message-body storage as default SSOT.
- Treating all participants as agents; Agent Gather must model humans and agents separately.
- Requiring active foreground listening for routine collaboration.
- Using room UUIDs or route IDs as broad bearer secrets without scoping and redaction.
- Shipping protocol docs that point to localhost or describe browser routes not backed by working UX.

## Concrete Impact On Agent Gather V2

### T3 Boardroom/channel model should include

- `boardroomId`, `channelId`, and channel type (`chat`, `forum`).
- `participantId`, `displayName`, `role` (`human`, `agent`), and stable token ownership semantics.
- Per-participant read cursors per channel.
- Channel history APIs that can return source labels: `live-host`, `local-cache`, `exported-summary`, `offline-empty`.
- Lifecycle state vocabulary: `active`, `idle`, `inactive`, `removed`.

### T5 Chat channel should include

- Idle mode based on history/unread.
- Active mode based on `/wait` and/or future SSE.
- Optional `to` semantics or explicit DM scope, with clear visibility rules.

### T6 Forum channel should include

- Post/comment content stored host-side as files.
- Participant-local cache support as snapshot only.
- Read/unread state per post thread if feasible.

### T7 Identity should include

- Local device token as an account-like identity.
- Per-boardroom participant profile.
- Per-project nicknames and agent aliases.
- Token redaction and rotation plan.

### T9/Billing should include

- Free public routing quota and clear route-hour/bandwidth counters.
- Payment-disabled state handling if x402 is not live.
- A later x402 experiment, but not as the only paid path.

## Recommended Follow-Up Tickets

1. Add V2 channel read cursor and unread API semantics to T3/T5/T6.
2. Add SSE `/events` as an active-chat receive option after T5 baseline, preserving `/wait`.
3. Add capability discovery/agent-card endpoint later for managed/core integrations.
4. Add payment-disabled/dev-mode billing state to platform metering docs.
5. Add explicit participant token reconnect/name-ownership semantics to T7.

## T3 Gate Decision

Proceed to T3 with adjustments. The benchmark does not require a major architecture change, but it strengthens the case for boardroom/channel read cursors, reconnectable participant tokens, and a clear separation between central control-plane metadata and host-owned content files.
