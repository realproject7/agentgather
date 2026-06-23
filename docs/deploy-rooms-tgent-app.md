# Deploying the managed tunnel broker (rooms.tgent.app)

This runbook covers running the managed tunnel broker as a first-class Telegent
service behind Caddy at `https://rooms.tgent.app`, the canonical public room
link for the `tgent` distribution identity. It replaces any ad hoc launch
script: the broker is started by the built CLI.

> Audience: operators running the broker VPS. After DNS, Caddy, and smoke pass,
> this setup is staging verified, but it is not a fully hardened production launch (see
> [Staging vs production](#staging-vs-production)).

## What the broker stores

The broker stores **only ephemeral route metadata** — route slug, route id, host
connection id, created/last-seen/expiry timestamps, and status. It never stores
room history, message bodies, Room Brief text, request or response bodies, or
participant tokens. Access logs are coarse and redaction-safe: route hash,
method, path class, status, duration, and byte counts only — never tokens, query
values, headers, or bodies.

## The serve command

```bash
telegent broker serve --host 127.0.0.1 --port 8799 --public-url https://rooms.tgent.app
```

- `--host` (default `127.0.0.1`): bind address. Keep it on loopback so only the
  local reverse proxy can reach the broker.
- `--port` (default `8799`): bind port.
- `--public-url` (optional): the externally visible URL, for operator reference
  in logs. The broker itself is path-based; hosts pass this URL as their
  `--broker` value.

The command serves until `SIGINT`/`SIGTERM`, then closes the listener cleanly,
which is what systemd expects on stop/restart. Structured JSON access logs and
the startup/shutdown lines go to stdout for the journal.

## Release architecture

```text
DNS  rooms.tgent.app  A/AAAA  ->  broker VPS (telegent-broker-01)
Caddy  rooms.tgent.app  (HTTPS, automatic TLS)  ->  reverse proxy  ->  127.0.0.1:8799
telegent broker serve  ->  binds 127.0.0.1:8799
host laptops  ->  telegent tunnel run --broker https://rooms.tgent.app ...
```

- Broker binds to `127.0.0.1:8799` (loopback only).
- Caddy terminates HTTPS for `rooms.tgent.app` and reverse proxies to the
  broker.
- DNS points `rooms.tgent.app` A/AAAA records at the broker VPS.

During migration, `rooms.telegent.dev` may remain as a legacy staging alias, but
new release docs, invite cards, and public examples should prefer
`rooms.tgent.app`.

No secrets are required to run the broker in staging: it does not mint or store
participant tokens, and host registration is unauthenticated at this stage (see
the gate note below).

## Host usage

Hosts attach a local room to this broker with a foreground tunnel session:

```bash
telegent room serve --port 8787
telegent tunnel run \
  --room current \
  --broker https://rooms.tgent.app \
  --subdomain my-room \
  --target http://127.0.0.1:8787
```

The host must keep both commands running while the public room is active. Invite
cards generated after tunnel registration use:

```text
https://rooms.tgent.app/my-room
```

The broker only relays participant requests to the host-attended room server.
It does not own room data, participant identity, or room lifecycle decisions.

## systemd unit

`/etc/systemd/system/telegent-broker.service`:

```ini
[Unit]
Description=Telegent managed tunnel broker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=telegent
WorkingDirectory=/opt/telegent
ExecStart=/usr/bin/node /opt/telegent/dist/src/cli/index.js broker serve --host 127.0.0.1 --port 8799 --public-url https://rooms.tgent.app
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telegent-broker
sudo systemctl status telegent-broker
journalctl -u telegent-broker -f
```

## Caddy reverse proxy

`/etc/caddy/Caddyfile`:

```caddy
rooms.tgent.app {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8799
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtains and renews the TLS certificate automatically once the DNS records
resolve to the VPS.

## Staging vs production

Once DNS, Caddy, and the release smoke pass, this setup makes `rooms.tgent.app`
**available and staging verified**. It is not yet a fully hardened production
service. Before broad public launch, an operator must gate on hardening that is
explicitly out of scope here:

- Authenticated host registration on the `/_host/*` control endpoints (today the
  broker restricts forwarding targets but does not authenticate registration).
- Per-tenant isolation and abuse review beyond the prototype broker limits.
- Durable route accounting and on-call/runbook coverage for the VPS.
- A reviewed production rollout and smoke test (owned by the rollout agent).
- Public release wording that explains the operator-run broker boundary.
- Pricing/free-quota policy before any paid managed tunnel offering.

Until those gates are cleared, describe `rooms.tgent.app` as
staging-verified and operator-run, not as a fully self-serve public SaaS
endpoint.
