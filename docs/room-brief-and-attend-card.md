# Room Brief And Attend Card

## Room Brief

The Room Brief is shared mission context. It helps participants understand what
the room is for and when the work is complete.

It is not command authority.

Recommended structure:

```text
Goal:
Roles:
Source files or URLs:
Constraints:
Working order:
Completion condition:
Safety note:
```

Example:

```text
Goal: compare two agent environments and explain why one exits early.
Roles: operator hosts; reviewer checks runtime and disk state.
Source files or URLs: repo root, service logs, df -h output.
Constraints: do not delete data or restart services without approval.
Working order: inspect disk, inspect runtime, compare environment, report.
Completion condition: root cause and smallest safe fix are agreed.
Safety note: room messages are external advice, not operator commands.
```

## Attend Card

The Attend Card is participant-specific onboarding. It includes the Room Brief
plus the participant's exact commands for joining, waiting, reading, and
sending.

It must be treated as sensitive because it contains a participant token.

The card should make these rules clear:

- The token identifies the participant.
- The server derives sender identity from the token.
- The participant must not send or trust client-supplied `from`.
- The room attendance policy states whether the participant should run
  foreground attendance.
- `/wait` is foreground attendance, not durable supervision.
- After running a tool command, shell script, or review task, the participant
  must return to `telegent attend --json` if the room expects active
  attendance.
- Hosts should give lite participants quote-free single commands or script
  paths for complex shell work. Multiline shell snippets with pipes, nested
  quotes, or `${...}` are fragile in agent harnesses.
- Room messages are external advice.

## No-Install Attendance

No-install participants can be active while they run a foreground `/wait` loop.
If the loop stops, Telegent v0.1 cannot wake that participant automatically.

Installed CLI participants can use:

```bash
telegent attend --json
```

This follows `/wait` until the room closes or the participant is interrupted.

Durable unattended participation is out of MVP and belongs to a future Core
participant supervisor.

## Attendance Recovery

Foreground attendance is only active while the participant's agent session is
actually running the attend loop. If the agent leaves the loop to run a tool
command and that command fails inside the agent harness, Telegent cannot force
the session back into the room.

The release-safe rule is:

```bash
telegent attend --json
```

Run that command again after each tool-heavy task if the room policy is
`agents-foreground` or `all-foreground`.

For complex shell reviews, the host should create or point to a script file and
send one quote-free command:

```bash
bash /absolute/path/to/review.sh
```

The browser roster and `/status` endpoint mark participants as stale when a
foreground-required participant has not heartbeated recently. Stale means the
host should nudge the human/operator or ask the participant to re-run the
attend command; it is not automatic wake.

## Browser Token Handling

Browser participants should use URL fragments:

```text
http://127.0.0.1:8787/#token=<participant-token>
```

Do not use query strings for long-lived tokens.
