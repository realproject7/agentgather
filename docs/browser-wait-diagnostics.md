# Browser 30-second waits: coverage and failure diagnostics

Scope: #289 (the recorder), #295 (its first adoption), #303 (the coverage rule,
the whole surface, and the attachment-status signal).

## Why the rule is the wait surface

#289 chose which files to instrument from a census of the tests that had already
failed. CI run 31026009385 then reproduced the #248 lifecycle timeout on an
instrumented ancestor of `main` and published **zero artifacts**: the failure
landed in `test/browser-room-lifecycle.test.ts`, which the census had never
named. A census can only point at yesterday's failures, and the next one is
somewhere else by definition.

So coverage is defined by the **wait surface** — every test block that drives a
browser, and therefore can sit on the standard 30-second ceiling — and not by
filenames, failure history, or wait counts. `scripts/browser-wait-surface.mjs`
states that rule once; `test/diagnostics-coverage.test.ts` runs the script rather
than re-implementing the rule, so the two cannot drift into agreeing with each
other while both being wrong.

Two consequences worth naming, because both were live gaps:

- **The surface is not `browser-*.test.ts`.** `test/e2e/acceptance.test.ts` and
  `test/e2e/tunnel-room.test.ts` drive a browser under a different name, and #291
  investigated a timeout in one of them. The survey finds files by their
  `playwright` import.
- **A fixture's own waits are in the surface.** Four files launch the browser
  inside `startFixture()`; those waits run *before any test body*, so a failure
  there could never have reached a test-level `catch`.
  `browser-manage-joined`'s entry wait carries an explicit 30-second ceiling, and
  #277's specimen (run 31026583592, 30961.7ms) has exactly that shape. The
  recorder is created in the fixture and handed back on the fixture object, and
  the fixture writes under its own `…-fixture-setup` label.

A block counts as covered only if it **attaches** a recorder, **writes** on
failure, and **rethrows** the original error. A `catch` that wrote without
rethrowing would turn a failure into a pass; a recorder attached and never
written is the same silence with more code.

## Inventory at the time of writing

Regenerate with `node scripts/browser-wait-surface.mjs` (exit 1 lists any gap).

| file | browser blocks | covered | 30s-ceiling waits | fixture setup wired |
| --- | ---: | ---: | ---: | --- |
| `browser-boardroom-shell.test.ts` | 3 | 3 | 14 | n/a |
| `browser-diagnostics.test.ts` | 3 | 3 | 3 | n/a |
| `browser-forum.test.ts` | 6 | 6 | 31 | n/a |
| `browser-launch.test.ts` | 1 | 1 | 3 | n/a |
| `browser-manage-joined.test.ts` | 9 | 9 | 18 | yes |
| `browser-platform.test.ts` | 38 | 38 | 135 | n/a |
| `browser-room-lifecycle.test.ts` | 5 | 5 | 26 | n/a |
| `browser-room.test.ts` | 54 | 54 | 206 | n/a |
| `browser-shell-rail-resize.test.ts` | 14 | 14 | 11 | yes |
| `browser-shell-repo-link.test.ts` | 5 | 5 | 2 | yes |
| `browser-snapshot-unreadable.test.ts` | 8 | 8 | 0 | yes |
| `e2e/acceptance.test.ts` | 1 | 1 | 2 | n/a |
| `e2e/tunnel-room.test.ts` | 1 | 1 | 4 | n/a |
| **total** | **148** | **148** | **455** | |

**Exceptions: none.** `EXCEPTIONS` in `scripts/browser-wait-surface.mjs` is the
only place an omission can live, and an entry must name the block and a concrete
technical reason. Size and failure history are not reasons.

## The specimens

Recorded as evidence of the class, not as an explanation of it. Nothing here
establishes the cause of the underlying lifecycle race, and this ticket does not
attempt to fix it.

| Test | Failing duration | Normal duration | Decomposition |
| --- | ---: | ---: | --- |
| composer dedupe (#289) | 33145ms | ~3600ms | 3145ms after the 30s ceiling — normal work at normal speed plus one wait |
| boardroom rail (#289) | 30782ms | ~1900ms | 782ms after the 30s ceiling — pre-wait work plus one wait |
| #277 filters, run 31026583592 | 30961.7ms | 950.4–1014.7ms | 961.7ms after the 30s ceiling — inside its observed normal range |
| #248 lifecycle, run 31026009385 | 30s lifecycle timeout | not captured | uninstrumented; the reason this ticket exists |

Each decomposes into ordinary work at ordinary speed **plus one wait that
consumed its entire ceiling** — a missing event, not a slow machine. A rerun
cannot characterise a missing event, which is what the recorder is for.

## What a failed CI run now says

`if-no-files-found: ignore` made "the recorder was quiet" and "the recorder was
never attached" identical from outside. On a failed run CI now runs
`scripts/diagnostics-attachment-status.mjs` **before** the upload, which writes
`attachment-status.md` into the artifact directory and echoes it to the job
summary. Three branches, and the artifact always exists:

- artifacts present → the recorder attached and wrote; the files are named.
- none, and the surface is fully covered → attached and quiet; the run failed
  outside the browser wait surface, or before the awaited `catch`.
- none, with uncovered blocks → the blocks are listed by file, line and title.

It reports **names and counts only** — never artifact contents — so it cannot
leak what the recorder is built never to collect. With a file guaranteed,
`if-no-files-found` is now `error`: an empty upload means the status step itself
did not run, which is worth failing on.

## Retention

`retention-days: 30`. The #289 retirement bound is *no failing trace within 30
days or 200 CI runs*; at 14 days a trace captured early in that window expired
before the decision it exists to inform. Artifact retention now covers the
decision window rather than half of it.

## Overhead

Attaching a recorder costs listeners and in-memory events, and the ticket asks
whether that is measurable. Measured as a same-session control: three full-suite
runs at `0432d6f` (the pre-#303 parent) against three at the wiring commit, same
machine, same conditions, built the same way.

| | runs (s) | mean | spread |
| --- | --- | ---: | ---: |
| before (579 tests) | 205.8 / 207.5 / 215.3 | 209.5 | 9.5 |
| after (586 tests) | 206.5 / 213.3 / 203.9 | 207.9 | 9.4 |

The after-mean is 1.6s **lower** than before, while run-to-run spread is ~9.5s on
both sides — and the after runs also carry seven new tests, one of which drives a
whole extra browser. Attachment overhead is therefore **below the noise floor of
this machine**, which is a statement about measurability and nothing more: it is
not evidence that the overhead is zero, and none of these numbers say anything
about the 2-core CI runner or about the lifecycle defect itself. The earlier
202.2s ±1s figure was taken in a different session; only the paired runs above
are a controlled comparison.

Per the ticket's operational constraint: a quiet period after this lands is not
evidence the lifecycle defect is fixed. The #289 retirement bound — no failing
trace within 30 days or 200 CI runs — remains independent, and artifact retention
now covers it.

## What is captured, and what cannot be

Redaction by construction (#289): the recorder never reads headers or
request/response bodies, so no artifact can hold them. What it records is method,
status, resource type, timing, console and page-error text, and URLs — each
redacted before storage. `test/browser-diagnostics.test.ts` proves this against a
captured artifact from a fixture that authenticates with a real bearer token and
enters over a token fragment, and `test/diagnostics-forced-failure.test.ts`
re-proves it on the artifact a real forced failure drops.

## Positive controls

Every claim here is checked against produced output, because each of these
assertions has a reassuring failure mode:

- `diagnostics-forced-failure.test.ts` runs the shipped #248 lifecycle block with
  its awaited element made unreachable, and asserts the probe **failed on that
  wait** before reading the artifact. Without that control, "an artifact exists"
  would survive a probe that never reached the browser. The injection is placed
  after entry has rendered, so the artifact describes a live session rather than
  an empty one.
- `diagnostics-coverage.test.ts` drives the guard over a synthetic tree with a
  deliberate gap. Without it, `exit 0` on the real tree would be equally
  consistent with a guard that can never fail.
- The green-run assertion drives a live recorder and then asserts no artifact
  directory exists — with an event count first, so "no files" is a statement
  about a working recorder rather than a dead one.
