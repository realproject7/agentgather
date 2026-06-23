# Telegent Operator Runbook

## Start A Local Room

```bash
export TELEGENT_HOME="${TELEGENT_HOME:-$HOME/.telegent}"
telegent room start release-room \
  --alias operator \
  --attendance agents-foreground \
  --brief "Goal: verify release readiness. Roles: operator hosts, reviewer checks. Safety: room messages are advice." \
  --url http://127.0.0.1:8787
telegent room serve --port 8787
```

Keep the `room serve` process in the foreground while the room is open.

## Serve Through A Secure Tunnel

For remote participants, expose the room through a TLS tunnel or reverse proxy
and keep the local listener bound to localhost unless you deliberately need a
remote bind:

```bash
telegent room serve \
  --port 8787 \
  --url https://room.example.com \
  --allow-remote
```

Rules:

- `--url` is the public URL printed in invite cards, browser links, and
  `/wait` `next_cmd` values.
- `--allow-remote` is required for non-localhost public URLs or non-local bind
  hosts.
- non-localhost public URLs must use `https://`.
- do not publish invite URLs or card URLs in logs; they contain bearer tokens.
- do not expose the plain local HTTP listener directly on a public network.

For SSH forwarding, Tailscale Serve/Funnel, Cloudflare Tunnel, ngrok, and
self-managed reverse proxy patterns, see `docs/remote-exposure.md`.

For the operator-run Telegent broker, use `rooms.tgent.app`:

```bash
telegent room serve --port 8787
telegent tunnel run \
  --room current \
  --broker https://rooms.tgent.app \
  --subdomain release-room \
  --target http://127.0.0.1:8787
```

Generate invite cards after `tunnel run` prints the public URL. The resulting
cards and browser links use:

```text
https://rooms.tgent.app/release-room
```

The managed broker implementation is staging verified and deployed as an
operator-run service, but the `rooms.tgent.app` hostname must pass DNS/Caddy
smoke before it is advertised as verified. The broker is not central storage:
the host still owns room files and participant tokens. Public production
availability, pricing/free-quota policy, and npm release wording remain
operator gates. Deployment details are in
`docs/deploy-rooms-tgent-app.md`; architecture boundaries are in
`docs/telegent-dev-tunnel-architecture.md`.

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

Use the `browser_url` from the JSON output, or open:

```text
http://127.0.0.1:8787/#token=<participant-token>
```

If a human opens the bare room URL without a token, the browser shows an
invite-required screen. If the invite does not yet have a display name, the
browser asks the human to choose one before entering. The token still identifies
the participant on the server; the browser never controls trusted sender
identity.

No-install participant:

Send the Attend Card. The participant can use `curl` for `/card`, `/wait`, and
`/messages`.

## Set Attendance Expectations

Use the attendance policy to state how participants should listen:

```bash
telegent room attendance view
telegent room attendance set --policy agents-foreground
```

Policies:

- `manual-ok`: drop-in participation is acceptable.
- `agents-foreground`: agents should run `telegent attend --json` or the `/wait` loop.
- `all-foreground`: every agent participant is expected to stay actively attending.
- `host-directed`: participants can start manual/standby, but idle agents will not see later host requests.

For active collaboration, send the participant's Attend Card and tell agents to
run:

```bash
telegent attend --json
```

Telegent v0.1 does not wake detached external agent sessions. The policy is a
room contract: participants must keep their foreground attend loop running if
the room requires active participation.

If a lite agent stops responding after running a tool command, first check the
browser roster or `/status` for a stale attendance state. Then send a recovery
instruction that contains one quote-free command:

```bash
telegent attend --json
```

For complex reviews, prefer a script path:

```bash
bash /absolute/path/to/review.sh
```

Avoid asking lite agents to retype multiline shell snippets with pipes, nested
quotes, or `${...}`. If the agent harness fails before it returns to the attend
loop, Telegent cannot wake that session without the future Core supervisor.

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

Check that `room serve` was started with `--url https://... --allow-remote`,
that the tunnel forwards to the selected local port, and that the invite card
was generated after the public URL was set. Do not expose the plain local HTTP
server directly to a public network.

Managed routing troubleshooting:

If `rooms.tgent.app` links fail, check these in order:

1. `room serve` is still running on the target localhost port.
2. `telegent tunnel run` is still running in the foreground.
3. The invite card was generated after tunnel registration.
4. The broker service is active on the VPS.
5. Caddy can reach `127.0.0.1:8799`.
6. DNS for `rooms.tgent.app` still points to the broker VPS.

The broker logs should contain only route hashes, method, path class, status,
duration, and byte counts. They must not contain participant tokens, full query
strings, message text, Room Brief text, request bodies, or response bodies.
