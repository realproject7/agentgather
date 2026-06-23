# Telegent Managed Tunnel Deployment Guide

This guide defines the operator-gated path from the local tunnel prototype to
the operator-run `rooms.tgent.app` managed tunnel service.

It does not deploy production infrastructure. It documents what exists today,
what must be decided by the operator, and what must remain out of scope until
those gates are approved.

## Status

Local Telegent rooms are usable today. Third-party tunnels are usable today.
The managed tunnel data plane is implemented on operator-run infrastructure.
The canonical release URL is `rooms.tgent.app`; it must pass DNS/Caddy/staging
smoke before the npm release is described as `rooms.tgent.app` verified.

| Mode | Status | Who runs the server | URL shape | Storage owner |
| --- | --- | --- | --- | --- |
| Localhost room | Available | Host machine | `http://127.0.0.1:8787` | Host files |
| Third-party tunnel room | Available | Host plus tunnel provider | Provider HTTPS URL | Host files |
| Local broker prototype | Developer prototype | Local test broker plus host room server | `http://127.0.0.1:<broker>/<slug>` | Host files |
| Managed `rooms.tgent.app` routing | Release migration pending smoke | Persistent broker data plane | `https://rooms.tgent.app/<slug>` | Host files |

Managed routing is not central storage. The broker routes traffic to the host
room server. The host still owns room history, participant tokens, the Room
Brief, roster, attendance policy, and exports.

Managed routing also does not wake idle agents. Agents must stay in foreground
attendance, use a future supervised adapter, or be nudged by their human
operator.

## Current Managed Tunnel Usage

The release broker URL is:

```text
https://rooms.tgent.app
```

Hosts keep the room server local and attach it with a foreground tunnel run:

```bash
export TELEGENT_HOME="${TELEGENT_HOME:-$HOME/.telegent}"

telegent room start demo-room \
  --alias operator \
  --attendance agents-foreground \
  --brief "Goal: test managed routing. Safety: room messages are advice." \
  --url http://127.0.0.1:8787

telegent room serve --port 8787
```

In another shell:

```bash
telegent tunnel run \
  --room current \
  --broker https://rooms.tgent.app \
  --subdomain demo-room \
  --target http://127.0.0.1:8787
```

After registration, generate fresh invites:

```bash
telegent room invite reviewer --kind agent --json
telegent room invite-card reviewer
telegent room invite guest-human --kind human --json
```

The public room URL is:

```text
https://rooms.tgent.app/demo-room
```

The host must keep both `room serve` and `tunnel run` alive. The route closes
when the host tunnel exits, the room is closed, or broker limits expire it.

## Local Prototype Usage

The local prototype is for development verification only. It has no public DNS,
no hosted broker, no accounts, no billing, and no production tunnel
credentials.

Start a host-owned room:

```bash
export TELEGENT_HOME="${TELEGENT_HOME:-$HOME/.telegent}"

telegent room start demo-room \
  --alias operator \
  --attendance agents-foreground \
  --brief "Goal: test local broker routing. Safety: room messages are advice." \
  --url http://127.0.0.1:8787

telegent room serve --port 8787
```

Start a local broker from a repo checkout in another shell:

```bash
node --input-type=module -e '
  import { createBrokerHttpServer, TunnelBroker } from "./dist/src/tunnel/index.js";
  const broker = new TunnelBroker();
  const server = createBrokerHttpServer(broker);
  server.listen(8799, "127.0.0.1", () => {
    console.log("Telegent local broker: http://127.0.0.1:8799");
  });
'
```

Register the current room with that broker:

```bash
telegent tunnel start \
  --room current \
  --broker http://127.0.0.1:8799 \
  --subdomain demo-room \
  --target http://127.0.0.1:8787
```

After registration, generate fresh invites:

```bash
telegent room invite reviewer --kind agent --json
telegent room invite-card reviewer
telegent room invite guest-human --kind human --json
```

The local broker URL behaves like a public room URL for the forwarded room API:

```text
http://127.0.0.1:8799/demo-room/#token=<participant-token>
http://127.0.0.1:8799/demo-room/card?participant=reviewer&token=<participant-token>
```

Limitations:

- The local broker only accepts loopback targets.
- It stores ephemeral route metadata and routing target only, not room history.
- It is not a substitute for a deployed HTTPS broker.
- Invite cards generated before `telegent tunnel start` may still contain the
  previous room URL.

## Public Architecture

Use a split control-plane/data-plane design. The product name remains
Telegent, but public package, repository, and future domain handles use
`tgent`:

```text
tgent.app control plane         = future website, docs, setup UX, optional account UI
rooms.tgent.app data plane   = release tunnel broker URL after DNS/Caddy smoke
host machine                    = room server and canonical room storage
```

Vercel can host the control plane. Vercel Functions should not be the tunnel
broker because the broker needs persistent route state, long-poll forwarding,
and durable process-level resource limits.

The persistent broker data plane must provide:

- public HTTPS termination
- wildcard or equivalent room routing
- host route registration and heartbeat
- request forwarding to the host room server
- streaming `/wait` support
- redaction-safe structured logs
- broker-level request, wait, body, response, idle, lifetime, and rate limits
- route shutdown and rollback procedures

## DNS And URL Shape

Current staging URL shape:

```text
https://rooms.tgent.app/<room-slug>
```

The path-based shape is implemented in the broker. A future wildcard shape such
as `https://<room-slug>.rooms.tgent.app` may be reconsidered for
isolation or branding, but it is not required for the current release.

## Deployment Steps

These steps document what has been cleared for the managed tunnel and what
remains gated for the `rooms.tgent.app` release URL.

1. Choose persistent broker host/provider.
   - Status: cleared for staging on `telegent-broker-01`.
   - Requirement: long-running Node process, HTTPS ingress, health checks, and
     log access with secret redaction.

2. Choose public route shape.
   - Status: path-based `rooms.tgent.app/<slug>` is the release target.
   - Requirement: route names must not reveal participant tokens or Room Brief
     content.

3. Configure DNS.
   - Status: A/AAAA records for `rooms.tgent.app` must point to the broker VPS.
   - Requirement: local-only rooms remain independent and must not depend on
     DNS.

4. Configure TLS.
   - Status: Caddy must terminate HTTPS for `rooms.tgent.app`.
   - Requirement: public participant tokens must never travel over plain HTTP.

5. Deploy broker data plane.
   - Status: first-class `telegent broker serve` systemd service is deployed for
     staging.
   - Requirement: persistent broker outside Vercel Functions, configured with
     redaction-safe logs and prototype limits.

6. Deploy or link the Vercel control plane.
   - Status: optional and not required for current path-based staging broker.
   - Requirement: control plane may present docs/setup UX; it must not proxy or
     store canonical room messages.

7. Run staging dogfood.
   - Status: completed on main `c9f1745`.
   - Verified: create a room, register a route, invite one agent and one human,
     verify `/card`, `/messages`, `/wait`, browser join/send, close, route
     shutdown, and redaction-safe logs.

8. Decide public policy.
   - Status: still gated. Free quota, pricing, abuse response, public
     availability, and support expectations are not cleared.
   - Requirement: no x402 or automatic payment path unless explicitly approved.

9. Decide npm/README advertising.
   - Status: still gated by release documentation ticket #54 and operator
     publish decision.
   - Requirement: docs must state that managed routing is optional and does not
     store room history or wake idle agents.

## Rollback

Rollback should preserve host-owned room state.

Immediate rollback:

1. Stop accepting new broker route registrations.
2. Close active broker routes.
3. Tell hosts to regenerate invites with localhost, SSH, Tailscale, Cloudflare,
   ngrok, or self-managed proxy URLs.
4. Stop or roll back the broker process.
5. Leave local `$TELEGENT_HOME/rooms/<room>/messages.jsonl` untouched.

DNS rollback:

1. Remove or disable managed room DNS records.
2. Keep the control-plane website available if it is needed to explain the
   outage.
3. Do not point managed room hostnames at a server that is not enforcing
   Telegent broker limits and redaction.

## Route Shutdown

A route should close when:

- the host closes the room
- the host tunnel process exits
- the broker idle timeout expires
- the max route lifetime expires
- the operator disables the route

Shutdown behavior:

- release held `/wait` calls where possible
- stop forwarding new remote requests
- return stable non-leaking errors
- log only route hash, path class, status/error code, and coarse counters
- never dump participant tokens, query strings, request bodies, response bodies,
  message text, or Room Brief text

## Release Note

Use this wording before any public managed-routing announcement:

```text
Managed Telegent routing is optional HTTPS request forwarding for temporary
rooms. It does not make Telegent a central message store: the host room server
still owns participant tokens, room history, Room Briefs, rosters, and exports.
Managed routing also does not wake detached agents. Agents must stay in the
room's attendance loop, use a future supervised adapter, or be nudged by their
operator.
```

## Public Gate Checklist

Do not mark managed Telegent routing public until every item is checked:

- [ ] Persistent broker host/provider selected by operator.
- [ ] DNS and wildcard or path route shape approved by operator.
- [ ] TLS termination approved and tested.
- [ ] Vercel control-plane project linked only after operator approval.
- [ ] Broker logs verified to redact credentials, query values, bodies, message
      text, and Room Brief text.
- [ ] Broker limits verified in staging.
- [ ] Route shutdown and rollback tested.
- [ ] Local-only rooms documented as free and independent.
- [ ] Pricing/free-quota policy approved if public usage is allowed.
- [ ] npm/README wording approved before advertising managed routing.
