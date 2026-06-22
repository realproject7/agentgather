# telegent.dev Tunnel Routing Architecture

`telegent.dev` is an optional routing layer for remote rooms. It must not become
the canonical message server.

The host still owns:

- room creation and close lifecycle
- participant tokens
- room history under `$TELEGENT_HOME/rooms/<room>/messages.jsonl`
- Room Brief, roster, attendance policy, and export artifacts

The routing service may own:

- public HTTPS names
- short room URLs
- tunnel session registration
- request forwarding
- abuse controls
- coarse usage metering

## Decision

Use a split architecture:

```text
telegent.dev control plane      = Vercel-hosted website/API and domain UX
*.rooms.telegent.dev data plane = persistent tunnel broker, not Vercel Functions
host CLI tunnel client          = outbound connection from host to broker
```

Do not implement the data plane as Vercel Functions. Vercel is suitable for the
marketing/control surface and domain management, but the tunnel needs long-lived
host connections, request multiplexing, and long-poll forwarding. Those are
better served by a small persistent broker process.

Recommended implementation order:

1. Documented architecture.
2. Local broker prototype with no public domain.
3. Operator deployment guide and public gate checklist.
4. Staging broker on persistent infrastructure after operator approval.
5. `telegent.dev` DNS/Vercel control plane after operator approval.
6. Metering and x402 only after product demand is proven.

## Data Flow

```text
remote participant
  -> https://room-slug.rooms.telegent.dev/messages
  -> tunnel broker
  -> existing outbound host tunnel connection
  -> host Telegent room server on http://127.0.0.1:8787
  -> host-owned room files
```

The broker never mints participant tokens and never writes canonical messages.
It forwards bytes between remote participants and the host room server.

## Components

### Host Room Server

The existing `telegent room serve` process remains the authority. It validates
participant bearer tokens, derives sender identity from token ownership, applies
loop guards, stores messages, and emits `/wait` responses.

For a managed tunnel, the room server should run locally:

```bash
telegent room serve --port 8787
```

The public URL is supplied by the tunnel client once it is connected:

```bash
telegent tunnel start --room current --subdomain room-slug
```

The tunnel client updates the local current room URL to
`https://room-slug.rooms.telegent.dev` only after the broker confirms the route.
Invite cards generated before that point may still contain localhost URLs.

### Host Tunnel Client

The host tunnel client opens an outbound authenticated connection to the broker.
The host does not need an inbound public port.

Responsibilities:

- authenticate the host to the broker with a tunnel session token
- register desired room slug and local target URL
- maintain heartbeat/reconnect
- multiplex HTTP requests from broker to local `room serve`
- close the route when the room closes or the process exits
- redact credentials from local diagnostic output

The host tunnel token is distinct from participant tokens. It authorizes routing
for one host room; it does not authorize posting messages.

### Tunnel Broker

The broker is the data plane for `*.rooms.telegent.dev`.

Responsibilities:

- terminate public HTTPS
- map `room-slug` to a live host tunnel connection
- forward supported HTTP requests to the host
- preserve method, path, headers required by the room API, and body
- stream long-poll `/wait` responses without buffering them to completion
- enforce broker-layer resource limits
- redact sensitive data from all logs and metrics

The broker may keep ephemeral route metadata:

```json
{
  "room_slug": "room-slug",
  "route_id": "rte_...",
  "host_connection_id": "conn_...",
  "created_at": "2026-06-22T00:00:00.000Z",
  "last_seen_at": "2026-06-22T00:00:10.000Z",
  "expires_at": "2026-06-22T08:00:00.000Z",
  "status": "connected"
}
```

The broker must not store:

- participant bearer tokens
- host tunnel secrets after hashing
- message bodies
- Room Brief bodies
- response bodies
- canonical room history

### Control Plane

The control plane can live on Vercel because it does not need to hold host tunnel
connections.

Responsibilities:

- public landing/docs for `telegent.dev`
- account/project setup later, if needed
- route reservation UI/API later, if needed
- billing/metering dashboard later, if needed
- operator-facing tunnel setup instructions

The control plane may store route metadata and billing counters after an
operator gate. It still must not store room history.

## Why Not Vercel As The Broker

Vercel is useful for domains, static pages, route setup UX, and ordinary request
handling. It is not the right first broker because the Telegent tunnel data
plane needs long-lived host connections and request multiplexing. Official
Vercel documentation for WebSocket-style realtime use points readers toward
dedicated realtime providers. The safer v0.1 architecture is to keep Vercel out
of the tunnel data path and use it only for the control surface.

Vercel rewrites can proxy to external origins, but they do not solve dynamic
host tunnel registration by themselves. Rewrites are better treated as a future
control-plane convenience, not the core tunnel mechanism.

## Request Behavior Through The Tunnel

All participant identity stays enforced by the host room server. The broker
does not parse participant tokens except to redact them from logs.

| Method | Path | Tunnel behavior |
| --- | --- | --- |
| `GET` | `/` | Forward to host; browser shell is served by host room server. |
| `GET` | `/room.css` | Forward to host; cache only if cache key excludes credentials and no query values are logged. |
| `GET` | `/room.js` | Forward to host; same cache rule as CSS. |
| `GET` | `/brief` | Forward with `Authorization`; do not log response body. |
| `POST` | `/brief` | Forward with body; host enforces host-only auth and body limit. |
| `POST` | `/attendance` | Forward body; host enforces host-only auth; broker records status-only metrics. |
| `GET` | `/status` | Forward with `Authorization`; broker may derive coarse availability metrics from status code only. |
| `GET` | `/messages` | Forward with `Authorization`; do not log message bodies or query values. |
| `POST` | `/messages` | Forward body; host derives `from` from bearer token. |
| `GET` | `/wait` | Forward and stream/hold response; support at least the host server hold window plus margin. |
| `GET` | `/card` | Forward query-token onboarding request; redact full query string. |
| `GET` | `/profile` | Forward with `Authorization`; do not log display names unless explicitly configured later. |
| `POST` | `/profile` | Forward body; do not log display names. |
| `POST` | `/join` | Forward; notify broker metrics by status only. |
| `POST` | `/leave` | Forward; broker may close participant-side connection after response. |
| `POST` | `/close` | Forward; if host confirms close, broker should mark route closing and release held requests. |

Unsupported paths return `404` from the host or broker without leaking route
metadata.

## Logging And Privacy

Tunnel-layer logs must be deny-by-default.

Never log:

- `Authorization` headers
- `Cookie` headers
- URL query strings or query values
- `/card?participant=...&token=...` URLs
- request bodies
- response bodies
- message text
- Room Brief text
- raw participant tokens
- raw host tunnel tokens

Allowed structured fields:

```json
{
  "route_hash": "sha256(room_slug + server_secret)",
  "method": "GET",
  "path_class": "/messages",
  "status": 200,
  "duration_ms": 42,
  "bytes_in": 0,
  "bytes_out": 1024,
  "wait_held_ms": 25000
}
```

For errors, log stable error codes, not raw request details.

## Resource Limits

Initial defaults for a prototype:

| Limit | Default | Reason |
| --- | ---: | --- |
| Host tunnel connections per route | 1 | One host owns the room. |
| Concurrent remote requests per route | 64 | Prevent one room from exhausting broker workers. |
| Concurrent `/wait` requests per route | 32 | Long-poll waiters are the expensive path. |
| Maximum request body | 64 KB | Matches the host server default. |
| Maximum forwarded response body | 1 MB | Room APIs should be small; export should stay local for now. |
| Broker idle timeout | 15 minutes | Close abandoned routes. |
| Maximum route lifetime | 8 hours | Temporary-room product shape. |
| Per-IP unauthenticated rate | 60 requests/minute | Protect invite/card/status discovery. |
| Per-route aggregate rate | 600 requests/minute | Early abuse guard. |

The host room server remains the source of truth for participant rate limits and
loop guards. Broker limits are outer protection only.

## Operator Gates

Can be implemented before operator credentials:

- local broker prototype bound to localhost
- host tunnel client that connects to localhost broker
- route registration protocol and tests
- redaction tests
- request forwarding tests for every room endpoint
- docs and runbooks

Blocked by operator gate:

- Vercel project creation or linking
- `telegent.dev` DNS records, wildcard records, or nameserver changes
- public TLS certificates for `*.rooms.telegent.dev`
- deploying persistent broker infrastructure
- paid tunnel provider setup
- x402 payment configuration
- public pricing/free-tier policy
- npm publish that advertises managed tunnel routing

## Implementation Ticket Breakdown

1. **Tunnel protocol spike**
   - Add a local-only broker test harness.
   - Define host registration, route heartbeat, request envelope, response
     envelope, and close frames.
   - Acceptance: no public network or credentials required.

2. **Host tunnel client**
   - Add `telegent tunnel start --room current --broker <url> --subdomain <slug>`.
   - Maintain outbound connection and update current room URL after registration.
   - Acceptance: local broker can reach existing `room serve`.

3. **Broker forwarding core**
   - Forward the endpoint matrix in this document.
   - Stream `/wait` without buffering and enforce resource limits.
   - Acceptance: integration tests cover `/`, assets, `/brief`,
     `/attendance`, `/status`, `/messages`, `/wait`, `/card`, `/profile`,
     `/join`, `/leave`, and `/close`.

4. **Redaction and abuse controls**
   - Add structured logging with sensitive-field redaction tests.
   - Add request body, waiter, route, idle, and rate limits.
   - Acceptance: tests prove `Authorization`, query values, and bodies never
     appear in logs.

5. **Operator deployment guide**
   - Document DNS, TLS, broker deployment, Vercel control plane, rollback, and
     route shutdown.
   - Acceptance: no step requires hidden assumptions; all credential actions are
     marked operator gates.
   - Current guide: `docs/telegent-dev-deployment-guide.md`.

6. **Metering and x402 research**
   - Define usage counters, free quota units, spending caps, and payment prompts.
   - Keep disabled by default.
   - Acceptance: no automatic payment path exists without explicit operator
     configuration.

## Business Model Boundary

The monetized product, if any, is optional HTTPS tunnel routing:

```text
local rooms = free and independent
managed tunnel routing = optional paid convenience
```

Useful free-tier counters:

- route minutes
- forwarded requests
- forwarded bytes
- concurrent remote participants
- `/wait` held seconds

x402 may be useful later for agent-addressable pay-as-you-go routing, but only
with explicit daily caps, per-request caps, and confirmation thresholds. Tunnel
fees must stay separate from any future paid-agent service.

## Source Links

Checked on 2026-06-22:

- Vercel WebSocket support for Functions: https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections
- Vercel rewrites: https://vercel.com/docs/routing/rewrites
- Vercel reverse proxy rewrites: https://vercel.com/kb/guide/vercel-reverse-proxy-rewrites-external
- Vercel custom domains: https://vercel.com/docs/domains/working-with-domains/add-a-domain
- Vercel DNS records: https://vercel.com/docs/domains/managing-dns-records
