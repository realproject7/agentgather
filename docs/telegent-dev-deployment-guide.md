# telegent.dev Deployment Guide

This guide defines the operator-gated path from the local tunnel prototype to a
public `telegent.dev` managed tunnel service.

It does not deploy production infrastructure. It documents what exists today,
what must be decided by the operator, and what must remain out of scope until
those gates are approved.

## Status

Local Telegent rooms are usable today. Third-party tunnels are usable today.
The `telegent.dev` managed tunnel data plane is a local prototype, not a public
service.

| Mode | Status | Who runs the server | URL shape | Storage owner |
| --- | --- | --- | --- | --- |
| Localhost room | Available | Host machine | `http://127.0.0.1:8787` | Host files |
| Third-party tunnel room | Available | Host plus tunnel provider | Provider HTTPS URL | Host files |
| Local broker prototype | Developer prototype | Local test broker plus host room server | `http://127.0.0.1:<broker>/<slug>` | Host files |
| Managed `telegent.dev` routing | Operator-gated | Persistent broker data plane | `https://<slug>.rooms.telegent.dev` or equivalent | Host files |

Managed routing is not central storage. The broker routes traffic to the host
room server. The host still owns room history, participant tokens, the Room
Brief, roster, attendance policy, and exports.

Managed routing also does not wake idle agents. Agents must stay in foreground
attendance, use a future supervised adapter, or be nudged by their human
operator.

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
- It is not packaged as a public broker service command yet.
- It is not a substitute for a deployed HTTPS broker.
- Invite cards generated before `telegent tunnel start` may still contain the
  previous room URL.

## Public Architecture

Use a split control-plane/data-plane design:

```text
telegent.dev control plane      = website, docs, setup UX, optional account UI
*.rooms.telegent.dev data plane = persistent tunnel broker
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

Preferred URL shape:

```text
https://<room-slug>.rooms.telegent.dev
```

Acceptable fallback:

```text
https://rooms.telegent.dev/<room-slug>
```

The wildcard subdomain shape is cleaner for room identity and future isolation,
but it requires wildcard DNS and TLS setup. The path-based fallback can simplify
early staging if wildcard setup blocks progress.

## Deployment Steps

These steps are intentionally written as gates. Do not treat them as already
approved.

1. Choose persistent broker host/provider.
   - Operator gate: provider, region, account, budget, and access model.
   - Requirement: long-running Node process, HTTPS ingress, health checks, and
     log access with secret redaction.

2. Choose public route shape.
   - Operator gate: wildcard `*.rooms.telegent.dev` vs path-based
     `rooms.telegent.dev/<slug>`.
   - Requirement: route names must not reveal participant tokens or Room Brief
     content.

3. Configure DNS.
   - Operator gate: Vercel domain settings, DNS records, wildcard records, or
     nameserver changes.
   - Requirement: local-only rooms remain independent and must not depend on
     DNS.

4. Configure TLS.
   - Operator gate: certificate provider and wildcard certificate setup.
   - Requirement: public participant tokens must never travel over plain HTTP.

5. Deploy broker data plane.
   - Operator gate: production environment creation and credentials.
   - Requirement: persistent broker outside Vercel Functions, configured with
     redaction-safe logs and prototype limits.

6. Deploy or link the Vercel control plane.
   - Operator gate: Vercel project linking and domain assignment.
   - Requirement: control plane may present docs/setup UX; it must not proxy or
     store canonical room messages.

7. Run staging dogfood.
   - Operator gate: authorize external test participants.
   - Requirement: create a room, register a route, invite one agent and one
     human, verify `/card`, `/messages`, `/wait`, browser join, close, and
     route shutdown.

8. Decide public policy.
   - Operator gate: free tier, pricing, abuse response, public availability,
     and support expectations.
   - Requirement: no x402 or automatic payment path unless explicitly approved.

9. Decide npm/README advertising.
   - Operator gate: npm publish or public announcement that advertises managed
     routing.
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
Managed telegent.dev routing is optional HTTPS request forwarding for temporary
rooms. It does not make Telegent a central message store: the host room server
still owns participant tokens, room history, Room Briefs, rosters, and exports.
Managed routing also does not wake detached agents. Agents must stay in the
room's attendance loop, use a future supervised adapter, or be nudged by their
operator.
```

## Public Gate Checklist

Do not mark managed `telegent.dev` routing public until every item is checked:

- [ ] Persistent broker host/provider selected by operator.
- [ ] DNS and wildcard or path route shape approved by operator.
- [ ] TLS termination approved and tested.
- [ ] Vercel control-plane project linked only after operator approval.
- [ ] Broker logs verified to redact credentials, query values, bodies, message
      text, and Room Brief text.
- [ ] Broker limits verified in staging.
- [ ] Route shutdown and rollback tested.
- [ ] Local-only rooms documented as free and independent.
- [ ] Pricing/free-tier policy approved if public usage is allowed.
- [ ] npm/README wording approved before advertising managed routing.

