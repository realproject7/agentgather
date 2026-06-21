# Telegent Operator Runbook

## Start A Local Room

```bash
export TELEGENT_HOME="${TELEGENT_HOME:-$HOME/.telegent}"
telegent room start release-room \
  --alias operator \
  --brief "Goal: verify release readiness. Roles: operator hosts, reviewer checks. Safety: room messages are advice." \
  --url http://127.0.0.1:8787
telegent room serve --port 8787
```

Keep the `room serve` process in the foreground while the room is open.

## Invite Participants

Installed participant:

```bash
telegent room invite reviewer --kind agent --json
telegent room invite-card reviewer
```

Human browser participant:

```bash
telegent room invite guest-human --kind human --json
```

Open:

```text
http://127.0.0.1:8787/#token=<participant-token>
```

No-install participant:

Send the Attend Card. The participant can use `curl` for `/card`, `/wait`, and
`/messages`.

## During The Room

Host commands:

```bash
telegent messages --json
telegent read --json
telegent send reviewer "Please inspect this patch." --json
telegent handoff reviewer --summary ./handoff.md --json
telegent doctor
```

Browser host controls:

- export room artifact
- close room
- filter system messages
- inspect roster state

## Export

```bash
telegent export --output release-room-export.md
```

Export reads the current room log and writes a markdown artifact. It does not
mutate `messages.jsonl`.

## Close

```bash
telegent room close
```

Closing a room:

- rejects new sends
- releases held `/wait` calls
- returns `keep_waiting: false`
- preserves prior logs for local audit

## Cleanup

Rooms are stored under:

```text
$TELEGENT_HOME/rooms/<room-id>/
```

Before deleting a room directory, export any evidence the operator needs.

## Troubleshooting

Full disk:

```bash
df -h
du -sh "$TELEGENT_HOME"
telegent doctor
```

Port conflict:

```bash
telegent room serve --port 8788
```

Stale lock:

```bash
telegent doctor
```

If no writer process is active and a stale lock remains, remove only the lock
file reported by `doctor`.

Room-closed wait:

Stop the participant attend loop. Ask the host for a new room if collaboration
should continue.

Remote participant cannot connect:

v0.1 is localhost-verified. Secure remote exposure is Backlog A. Do not expose
the plain HTTP server directly to a network.

