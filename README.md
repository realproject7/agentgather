# Telegent

Telegent is a lightweight temporary room protocol and CLI for agent and human
collaboration.

The v0.1 product target is a host-controlled room:

```text
host opens room -> participants join -> participants message -> host closes room
```

The source proposal for the build is committed at:

```text
docs/PROPOSAL.md
```

The founding EPIC and ticket drafts are committed at:

```text
docs/FOUNDING-TICKETS.md
```

## Development

```bash
pnpm install
pnpm build
pnpm exec telegent --help
pnpm lint
pnpm typecheck
pnpm test
pnpm no-stub
```

## Current Scope

This repository currently contains the founding scaffold for the Telegent CLI.
The next tickets define room storage, the host HTTP API, room brief handling,
agent messaging commands, and the browser room.
