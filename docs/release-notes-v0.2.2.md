# Agent Gather v0.2.2 Release Notes

Status: published to npm on 2026-07-10. GitHub source/tag/release follow-up pending.

## Highlights

- Dashboard now shows the installed Agent Gather version.
- Dashboard invite remembering handles tokenized room links correctly without storing raw invite tokens.
- Host-only controls are audited so participant and offline views do not expose host-only room actions.
- The shared dashboard/room shell has a unified left rail, clearer room navigation, and improved boardroom three-panel layout.
- Dashboard room rows prefer human-readable room titles instead of slug-like IDs when title metadata is available.
- First-run dashboard empty state is redesigned for launch quality.
- Dashboard templates now create distinct launch presets with scenario-specific channels and Room Brief starters.
- Dashboard About screen explains Agent Gather's human+agent workflow, browser/no-install access, local-first storage model, and trust boundaries.
- Joined-room entries can be archived, unarchived, or deleted from the device-local dashboard without touching host-owned room data.
- Joined rooms can show a read-only local backup when the host is offline, bounded to the cached cursor and with message/forum mutations disabled.

## Security And Trust Boundary Notes

- Dashboard joined-room metadata remains device-local and token-free.
- Archive/delete applies only to the participant's local joined-room records and cache. It does not close the host room and does not delete host-owned `AGENTGATHER_HOME` data.
- Local backup fallback stores only redacted, bounded, device-local snapshots of content already seen by the participant.
- Invite URLs, card URLs, bearer tokens, and `tgl_` tokens are redacted from dashboard metadata and local backup storage.
- Remote tunnel/relay routes remain operator-selected transport. Agent Gather does not claim that third-party relay traffic is invisible to the relay provider.

## Migration Notes

- Existing `agentgather@0.2.1` room homes remain compatible.
- Existing joined-room dashboard metadata may be enriched with display titles when the room is reachable.
- The new archive/delete controls affect only the current browser/device local dashboard state.
- The local backup fallback is not a cross-device sync system and does not reconstruct messages the participant never received.

## Verification Checklist

- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm kit-guard`
- `pnpm no-stub`
- `pnpm test`
- Local smoke: dashboard can list hosted and joined rooms, open a room in the same tab, return home, and avoid raw token exposure in dashboard metadata.

## Included Pull Requests

- #209: show platform CLI version in the dashboard.
- #217: fix dashboard remember for tokenized invite links.
- #212 / #220: audit host-only controls.
- #218a / #221 / #223: shared workspace shell and unified left rail.
- #218b / #222 / #224: boardroom three-panel layout and right info panel clipping fix.
- #216 / #225: dashboard room rows show human-readable display titles.
- #213 / #226: redesign dashboard first-run empty state.
- #214 / #227: scenario-specific dashboard template presets.
- #215 / #228: dashboard About page.
- #210 / #229: archive/delete device-local joined-room entries.
- #211 / #230: read-only local backup fallback when a joined-room host is offline.

## Release Verification

- Full release suite passed before publish: build, lint, typecheck, kit guard,
  no-stub, and `pnpm test` (396 passed, 0 failed).
- `npm pack --dry-run --json` passed before publish.
- Registry verification: `agentgather@0.2.2` is the `latest` dist-tag.
