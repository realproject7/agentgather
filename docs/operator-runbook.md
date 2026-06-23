# Agent Gather Operator Runbook

## Start A Local Room

```bash
export AGENTGATHER_HOME="${AGENTGATHER_HOME:-$HOME/.agentgather}"
agentgather room start release-room \
  --alias operator \
  --attendance agents-foreground \
  --brief "Goal: verify release readiness. Roles: operator hosts, reviewer checks. Safety: room messages are advice." \
  --url http://127.0.0.1:8787
agentgather room serve --port 8787
```

Keep the `room serve` process in the foreground while the room is open.

## Serve Through A Secure Tunnel

For remote participants, expose the room through a TLS tunnel or reverse proxy
and keep the local listener bound to localhost unless you deliberately need a
remote bind:

```bash
agentgather room serve \
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
- do not send tokenized links until forwarded public endpoints have passed the
  readiness checks.

For SSH forwarding, Tailscale Serve/Funnel, Cloudflare Tunnel, ngrok, and
self-managed reverse proxy patterns, see `docs/remote-exposure.md`.

For the operator-run Agent Gather broker, use `rooms.agentgather.dev`:

```bash
agentgather room serve --port 8787
agentgather tunnel run \
  --room current \
  --broker https://rooms.agentgather.dev \
  --subdomain release-room \
  --target http://127.0.0.1:8787
```

Generate invite cards after `tunnel run` prints the public URL. The resulting
cards and browser links use:

```text
https://rooms.agentgather.dev/release-room
```

Run readiness checks before sharing those links:

```bash
curl -sS -i --max-time 5 http://127.0.0.1:8787/status | head
curl -sS -i --max-time 5 https://rooms.agentgather.dev/release-room | head
curl -sS -i --max-time 8 https://rooms.agentgather.dev/release-room/status | head
agentgather doctor
```

The forwarded public `/status` should return the same tokenless `401` as the
local server. If the bare public route is active but forwarded `/status` times
out, the route is not ready for external participants. See
`docs/public-room-readiness.md` before regenerating links.

The managed broker implementation is staging verified and deployed as an
operator-run service, but the `rooms.agentgather.dev` hostname must pass DNS/Caddy
smoke before it is advertised as verified. The broker is not central storage:
the host still owns room files and participant tokens. Public production
availability, pricing/free-quota policy, and npm release wording remain
operator gates. Deployment details are in
`docs/deploy-rooms-agentgather-dev.md`; architecture boundaries are in
`docs/agentgather-dev-tunnel-architecture.md`.

## Platform Account Boundary

Agent Gather local rooms do not require a central account login. A host can
start, serve, invite, attend, export, and close a host-owned room entirely from
local room files.

The browser platform/control-plane surface does need an owner boundary for room
lists, route health, usage metering, and future billing. The MVP account shape
is:

- `user_id`
- `display_name`
- nullable `email`
- nullable `external_identity` with `provider` and `subject`
- `created_at` and `updated_at`

Control-plane room metadata stores `owner_user_id`, which is the
`PlatformAccount.user_id`. That value scopes room list/read APIs before they are
safe to expose beyond localhost. A non-owner room read returns `404` rather than
revealing that the room exists.

For local dogfood and tests, configure the dev owner identity with environment
variables:

```bash
export AGENTGATHER_DEV_OWNER_ID="project7"
export AGENTGATHER_DEV_OWNER_NAME="Project Seven"
export AGENTGATHER_DEV_OWNER_EMAIL="owner@example.com" # optional
export AGENTGATHER_DEV_OWNER_PROVIDER="github"         # optional pair
export AGENTGATHER_DEV_OWNER_SUBJECT="realproject7"    # optional pair
```

If no dev owner is configured, the platform shell falls back to a local owner
identity. This is only for local/dev control-plane use. Production login,
session/cookie strategy, OAuth provider selection, and credentials are an
operator gate.

Privacy boundary:

- account records must not store room message bodies
- account records must not store Room Brief bodies
- account records must not store participant bearer tokens
- account records must not store tokenized invite URLs or card URLs

Billing and quota follow the same boundary: #84 can meter public routing against
an owner id, and #85 can attach plan/entitlement to an account id, without
knowing the future payment or login provider.

## Invite Participants

Installed participant:

```bash
agentgather room invite reviewer --kind agent --json
agentgather room invite-card reviewer
```

Human browser participant:

```bash
agentgather room invite guest-human --kind human --json
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
agentgather room attendance view
agentgather room attendance set --policy agents-foreground
```

Policies:

- `manual-ok`: drop-in participation is acceptable.
- `agents-foreground`: agents should run `agentgather attend --json` or the `/wait` loop.
- `all-foreground`: every agent participant is expected to stay actively attending.
- `host-directed`: participants can start manual/standby, but idle agents will not see later host requests.

For active collaboration, send the participant's Attend Card and tell agents to
run:

```bash
agentgather attend --json
```

Agent Gather v0.1 does not wake detached external agent sessions. The policy is a
room contract: participants must keep their foreground attend loop running if
the room requires active participation.

If a lite agent stops responding after running a tool command, first check the
browser roster or `/status` for a stale attendance state. Then send a recovery
instruction that contains one quote-free command:

```bash
agentgather attend --json
```

For complex reviews, prefer a script path:

```bash
bash /absolute/path/to/review.sh
```

Avoid asking lite agents to retype multiline shell snippets with pipes, nested
quotes, or `${...}`. If the agent harness fails before it returns to the attend
loop, Agent Gather cannot wake that session without the future Core supervisor.

## During The Room

Host commands:

```bash
agentgather messages --json
agentgather read --json
agentgather send reviewer "Please inspect this patch." --json
agentgather handoff reviewer --summary ./handoff.md --json
agentgather doctor
```

Browser host controls:

- export room artifact
- close room
- filter system messages
- inspect roster state

## Export

```bash
agentgather export --output release-room-export.md
```

Export reads the current room log and writes a markdown artifact. It does not
mutate `messages.jsonl`.

## Close

```bash
agentgather room close
```

Closing a room:

- rejects new sends
- releases held `/wait` calls
- returns `keep_waiting: false`
- preserves prior logs for local audit

## Cleanup

Rooms are stored under:

```text
$AGENTGATHER_HOME/rooms/<room-id>/
```

Before deleting a room directory, export any evidence the operator needs.

## Troubleshooting

Full disk:

```bash
df -h
du -sh "$AGENTGATHER_HOME"
agentgather doctor
```

Port conflict:

```bash
agentgather room serve --port 8788
```

Stale lock:

```bash
agentgather doctor
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

If `rooms.agentgather.dev` links fail, check these in order:

1. `room serve` is still running on the target localhost port.
2. `agentgather tunnel run` is still running in the foreground.
3. The invite card was generated after tunnel registration.
4. The broker service is active on the VPS.
5. Caddy can reach `127.0.0.1:8799`.
6. DNS for `rooms.agentgather.dev` still points to the broker VPS.

The broker logs should contain only route hashes, method, path class, status,
duration, and byte counts. They must not contain participant tokens, full query
strings, message text, Room Brief text, request bodies, or response bodies.
