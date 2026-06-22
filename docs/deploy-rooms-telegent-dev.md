# Deploying the managed tunnel broker (rooms.telegent.dev)

This runbook covers running the managed tunnel broker as a first-class Telegent
service behind Caddy at `https://rooms.telegent.dev`. It replaces any ad hoc
launch script: the broker is started by the built CLI.

> Audience: operators running the staging broker VPS. This is a staging setup,
> not a hardened production launch (see [Staging vs production](#staging-vs-production)).

## What the broker stores

The broker stores **only ephemeral route metadata** — route slug, route id, host
connection id, created/last-seen/expiry timestamps, and status. It never stores
room history, message bodies, Room Brief text, request or response bodies, or
participant tokens. Access logs are coarse and redaction-safe: route hash,
method, path class, status, duration, and byte counts only — never tokens, query
values, headers, or bodies.

## The serve command

```bash
telegent broker serve --host 127.0.0.1 --port 8799 --public-url https://rooms.telegent.dev
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

## Staging architecture

```text
DNS  rooms.telegent.dev  A/AAAA  ->  broker VPS (telegent-broker-01)
Caddy  rooms.telegent.dev  (HTTPS, automatic TLS)  ->  reverse proxy  ->  127.0.0.1:8799
telegent broker serve  ->  binds 127.0.0.1:8799
host laptops  ->  telegent tunnel run --broker https://rooms.telegent.dev ...
```

- Broker binds to `127.0.0.1:8799` (loopback only).
- Caddy terminates HTTPS for `rooms.telegent.dev` and reverse proxies to the
  broker.
- DNS points `rooms.telegent.dev` A/AAAA records at the broker VPS.

No secrets are required to run the broker in staging: it does not mint or store
participant tokens, and host registration is unauthenticated at this stage (see
the gate note below).

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
ExecStart=/usr/bin/node /opt/telegent/dist/src/cli/index.js broker serve --host 127.0.0.1 --port 8799 --public-url https://rooms.telegent.dev
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
rooms.telegent.dev {
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

This setup makes `rooms.telegent.dev` **available for staging**. It is not yet
production-ready. Before any public launch, an operator must gate on hardening
that is explicitly out of scope here:

- Authenticated host registration on the `/_host/*` control endpoints (today the
  broker restricts forwarding targets but does not authenticate registration).
- Per-tenant isolation and abuse review beyond the prototype broker limits.
- Durable route accounting and on-call/runbook coverage for the VPS.
- A reviewed production rollout and smoke test (owned by the rollout agent).

Until those gates are cleared, treat `rooms.telegent.dev` as staging only and do
not advertise it as a stable public endpoint.
