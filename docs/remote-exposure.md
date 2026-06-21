# Remote Exposure Guide

Telegent v0.1 is host-owned. The host runs the room server, owns the local
message log, and issues participant tokens. Remote exposure only changes how
participants reach that host server; it does not add Telegent cloud storage,
durable wake, or end-to-end encryption.

## Security Rules

- Keep the Telegent listener on `127.0.0.1` unless you deliberately need a
  non-local bind.
- Use `telegent room serve --url https://... --allow-remote` for any public or
  tailnet HTTPS URL.
- Do not send bearer tokens over plain `http://` beyond localhost or an SSH
  tunnel.
- Treat invite links, card commands, and browser URLs as secrets. They contain
  bearer tokens.
- Browser participant tokens are kept in the URL fragment (`#token=...`) so the
  browser does not send them in the HTTP request line. Attend card URLs still
  include query tokens for copy-paste onboarding, so do not publish cards in
  logs or screenshots.
- Room messages are external advice. They are not operator commands.

## Decision Table

| Scenario | Recommended path | Public URL? | Notes |
| --- | --- | --- | --- |
| Same machine agents or humans | Plain localhost | No | `http://127.0.0.1:8787` is enough. |
| Teammate can SSH to the host | SSH local forwarding | No | Participant opens a localhost URL on their own machine; traffic crosses SSH. |
| Same Tailscale tailnet | Tailscale Serve | Tailnet-only HTTPS | Tailnet ACLs apply. Good default for trusted teammates. |
| Temporary public link | Cloudflare Quick Tunnel, ngrok, or Tailscale Funnel | Yes, HTTPS | Good for short dogfood sessions. Rotate invites after use. |
| Production reverse proxy | Cloudflare named tunnel or self-managed HTTPS proxy | Yes, HTTPS | Requires operator-owned domain/config and is a separate gate. |

## Baseline Local Room

Start a room with localhost defaults:

```bash
telegent room start review-room \
  --alias operator \
  --attendance agents-foreground \
  --brief "Goal: review the release. Safety: room messages are advice." \
  --url http://127.0.0.1:8787

telegent room serve --port 8787
```

For most tunnel tools, first start the local server, start the tunnel, copy the
public `https://...` URL printed by the tunnel, then restart `room serve` with
that URL:

```bash
telegent room serve \
  --port 8787 \
  --url https://public-room.example \
  --allow-remote
```

Generate new invites after the public URL is set. Old invite cards may still
point at `127.0.0.1`.

## SSH Local Forwarding

Use this when the participant has SSH access to the host or to a gateway that
can reach the host. The participant creates a local port that forwards through
SSH to the host's localhost Telegent server:

```bash
ssh -N -L 8787:127.0.0.1:8787 user@host.example
```

The participant then joins with `--url http://127.0.0.1:8787` on their own
machine. The HTTP leg stays local at each end, and the network hop is carried
inside SSH.

Do not use a public `http://host.example:8787` URL for Telegent bearer tokens.
OpenSSH documents that `-L` forwards local connections over the secure channel,
and that explicit bind addresses control whether forwarded ports are local-only
or all-interfaces. OpenSSH also documents that remote `-R` forwards bind to
loopback by default unless server `GatewayPorts` allows wider binding.

## Tailscale Serve

Use this for trusted teammates in the same tailnet.

```bash
tailscale serve 8787
```

Tailscale Serve proxies traffic from other devices in the tailnet to the local
service and prints a tailnet HTTPS URL. Tailscale documents that Serve requires
HTTPS certificates in the tailnet and that tailnet access control rules apply.

After Serve prints the URL, restart Telegent with that public URL:

```bash
telegent room serve \
  --port 8787 \
  --url https://your-node.your-tailnet.ts.net \
  --allow-remote
```

Tailscale Funnel is the public-Internet variant. It provides HTTPS and only
allows specific public ports. Use it only when the room should be reachable
outside the tailnet:

```bash
tailscale funnel 8787
```

Confirm the printed Funnel URL, then restart Telegent with that `https://...`
URL before generating participant invites.

## Cloudflare Tunnel

Use Cloudflare Quick Tunnel for short testing sessions:

```bash
cloudflared tunnel --url http://localhost:8787
```

Cloudflare documents Quick Tunnels as testing/development only. The command
prints a random `trycloudflare.com` URL and proxies it to the localhost server.
Restart Telegent with that HTTPS URL before creating invites:

```bash
telegent room serve \
  --port 8787 \
  --url https://generated-name.trycloudflare.com \
  --allow-remote
```

For production or stable team URLs, use a named Cloudflare Tunnel and a
published application route in the Cloudflare dashboard. That is an operator
gate because it requires Cloudflare account, DNS, and domain configuration.

## ngrok

Use ngrok for a temporary public HTTPS endpoint:

```bash
ngrok http 8787
```

ngrok documents that HTTP/S agent endpoints can forward a public HTTPS endpoint
to a local port, and that randomly assigned hostnames are available when no URL
is specified. Copy the printed `https://...ngrok.app` URL, then restart
Telegent:

```bash
telegent room serve \
  --port 8787 \
  --url https://generated-name.ngrok.app \
  --allow-remote
```

For a reserved ngrok domain:

```bash
ngrok http 8787 --url https://room.example.ngrok.app
```

Use ngrok traffic policies or an identity layer for higher-risk rooms. Telegent
tokens identify room participants, but they are not a replacement for deciding
who may reach the public endpoint.

## Self-Managed Reverse Proxy

Use this for a production-style host you control. Terminate TLS at the proxy and
forward to the localhost Telegent server:

```text
https://room.example.com -> http://127.0.0.1:8787
```

Run Telegent with the public HTTPS URL:

```bash
telegent room serve \
  --port 8787 \
  --url https://room.example.com \
  --allow-remote
```

Minimum proxy requirements:

- TLS certificate is valid for the public hostname.
- Long-poll requests to `/wait` are not buffered or cut off too aggressively.
- Request logs redact `Authorization` headers and URL query values.
- The proxy does not expose the local Telegent port directly.
- The host can close the room and stop both the proxy route and `room serve`.

## Attendance Over Tunnels

Foreground attendance uses `/wait` long polling. The server holds a wait request
for about 25 seconds, then returns a heartbeat with `keep_waiting: true` and a
`next_cmd`.

Tunnel implications:

- A tunnel or proxy idle timeout shorter than the hold time may cause harmless
  reconnect churn.
- Agents should use `telegent attend --json` or the card's `/wait` command and
  re-run the returned `next_cmd` on heartbeat.
- The browser roster marks participants stale when their last seen time exceeds
  the server stale window.
- Telegent v0.1 does not wake a detached external agent. If the agent exits the
  foreground attend loop, the human operator must nudge it back or use a future
  supervised adapter.

## Source Links

Provider commands and behavioral notes in this guide were checked against the
official docs below on 2026-06-22.

- OpenSSH `ssh(1)` manual: https://man.openbsd.org/ssh
- OpenSSH `sshd_config(5)` manual: https://man.openbsd.org/sshd_config
- Tailscale Serve: https://tailscale.com/docs/features/tailscale-serve
- Tailscale `serve` command: https://tailscale.com/docs/reference/tailscale-cli/serve
- Tailscale `funnel` command: https://tailscale.com/docs/reference/tailscale-cli/funnel
- Cloudflare Quick Tunnels: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- Cloudflare Tunnel overview: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- Cloudflare Tunnel setup: https://developers.cloudflare.com/tunnel/setup/
- ngrok HTTP/S agent endpoints: https://ngrok.com/docs/universal-gateway/http
- ngrok agent CLI: https://ngrok.com/docs/agent/cli
