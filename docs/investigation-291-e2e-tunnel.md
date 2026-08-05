# #291 — e2e tunnel test: measured investigation of one observed failure

**Outcome: NOT REPRODUCED in 34 runs, and the recorded observation is not the failure class the ticket names.**

This record exists because the single observation behind #291 was never classifiable — only its
duration was captured. Anyone revisiting this should start here rather than re-deriving it.

Investigated at `af83e5f21af51ceb2a3a4ed85adcd732d7a48fb6`.
Test: `test/e2e/tunnel-room.test.ts` → *"e2e tunnel: browser human and curl agent reach the room through the broker"*.

## The observation being investigated

From the reporting message, quoted rather than summarised:

```
seen  ONCE, in a full --test-isolation=process run, 2.8s  (isolation: passes, ~1.5s)
      not reproduced in 4 subsequent full runs
```

Only the duration was recorded. **No error message, no stack, no failing assertion.** That is the
central limitation of this investigation and the reason it cannot end in a cause.

## Finding 1 — 2.8s cannot be a timeout

#291 is titled and scoped as a *timeout*. Nothing in this test can time out at 2.8 seconds:

| ceiling | value | source |
|---|---|---|
| test-level | none | `test(…)` at `:38` takes no options object |
| `node --test` | 180 s under `pnpm test` | `--test-timeout=180000`, `package.json` |
| `node --test` | Infinity, unflagged | Node's documented default; measured on v24.14.1 — unflagged 4 s and 35 s tests both pass |
| Playwright `waitForSelector` | 30 s | library default; the four calls at `:115/:118/:130/:133` pass no timeout option |

The two `node --test` rows matter because the observation came from an ad-hoc
`--test-isolation=process` invocation and **`package.json` has no isolation script**, so the 180 s
figure may not have applied to that run at all. It makes no difference: an unflagged run has no
ceiling that could fire at 2.8 s either, which was verified rather than assumed. The finding is
stronger, not weaker, for the ambiguity. (Raised by @re2 (local) in review of PR #301.)

Applying the decomposition used on #264 and #289 — subtract the expired ceiling from the total and
see whether the remainder is the test's normal runtime:

```
#264   ~32000 − 30000 = ~2000 ms  ≈ its normal runtime   → one wait consumed its whole ceiling
#289    33145 − 30000 =  3145 ms  ≈ its normal runtime   → same shape
#291     2800 − 30000 = NEGATIVE                         → no ceiling was consumed at all
```

So the failure was an **assertion or a thrown error that failed fast**, not a wait that expired.
It is a different signature class from #264, #270 and #289, not a milder instance of them.

## Finding 2 — 2.8s is this test's normal speed

Across 14 full-suite runs at this SHA the test **passed** with:

```
n=14   min=2075 ms   median=2295 ms   mean=2328 ms   max=2659 ms
```

The observed failure at 2800 ms is **141 ms above the observed maximum** — about 5%. The test failed
at essentially the speed it normally succeeds at. Whatever went wrong did not make it slow.

## Finding 3 — not reproduced

| sample | runs | command | result |
|---|---|---|---|
| focused, isolated | 20 | `node --test --test-timeout=180000 dist/test/e2e/tunnel-room.test.js` | **20/20 pass** |
| full suite | 6 | `node --test --test-timeout=180000 "dist/test/**/*.js"` | **6/6 pass**, 578/578 each |
| full suite, induced contention | 8 | same, with 6 concurrent busy loops | **8/8 pass**, 578/578 each |

**34 runs, zero failures of this test, and zero failing tests of any kind in the 14 full-suite runs.**

Load during the contention sample: **11.65–13.59** (mean 12.51) on 10 cores. Honest caveat: the
first full-suite sample was labelled "quiet" but ran at load **6.62–18.40** (mean 9.59) — the machine
was already busy, so this is **not** a clean quiet-vs-loaded comparison. Both samples are
loaded-machine samples, which is the condition #264 originally reported from.

## Finding 4 — probe-then-bind tested and not supported

`test/e2e/tunnel-room.test.ts:30-36` probes a free port, closes it, and binds it later at `:73`.
A losing race there raises `EADDRINUSE`, and because the `listen` promise has no `error` handler it
would surface as an unhandled `error` event — a **fast** failure, which fits the signature class.
Measured rather than argued, replicating the exact probe→close→bind shape:

```
600 rounds ×  4 concurrent workers → 0 collisions
600 rounds × 12 concurrent workers → 0 collisions
```

**0 in 1200 rounds**, independently reproducing the 0/600 the other lane measured on the same shape.
The shape fits; the rate does not. Not advanced as the cause.

## Finding 5 — CI has never seen it

Census of the last 60 CI runs: 54 success, 4 cancelled, 2 failure. **Neither failure is this test.**
In *both* failing runs this test passed — 811 ms and 2275 ms — while other browser tests consumed
their full 30 s ceilings. Its duration across 6 successful runs: **958–1077 ms** against a 30 s
ceiling.

So on CI it passes even in the runs where its neighbours time out, which is evidence against a
shared load-sensitivity mechanism.

### Finding 5 reproduced itself, unprompted, on this PR's own CI run

This document's PR is one Markdown file. Its CI run failed anyway:

```
run 31026583592   attempt=1   conclusion=failure   ℹ tests 578 · pass 577 · fail 1
✖ filters narrow the list, and select-all covers only the rows shown (#277)   30961.735976 ms
  page.waitForFunction: TimeoutError

   decomposition:  30961.7 − 30000 = 961.7 ms   vs that test's normal ~1128 ms
   → one wait consumed its entire ceiling: the missing-event signature

✔ e2e tunnel: browser human and curl agent reach the room through the broker   977.374647 ms
   → inside the 958–1077 ms band recorded above, in the same run
```

**The neighbour consumed its whole ceiling and this test passed at its normal speed, in the same
run.** That is Finding 5's central claim reproduced on a fresh specimen that nobody arranged — and
the fresh specimen belongs to the #289 family, not to this one, which is the distinction the whole
document exists to draw. The failing file (`test/browser-manage-joined.test.ts`) is not attached to
#289's recorder and the run produced **0 artifacts**, so it too was unclassifiable at the moment it
occurred. That consequence belongs to **#302**. (Specimen surfaced by @re2 (local) in review.)

## Conclusion

- **Not reproduced** in 34 runs across three sampling modes on the reporting platform.
- **Not the #264/#270/#289 class.** Those are one wait consuming its whole ceiling; this failed fast.
- **No cause claimed.** One observation, no error text; the evidence supports classification only.
- **No fix made.** #291 gates a fix on establishing a mechanism, and none was established.

## What would make a recurrence answerable

The evidence gap, not the flake, is what made this ticket unanswerable: a duration was recorded and
an error was not. #289 landed failure-only Playwright diagnostics
(`test/support/browser-diagnostics.ts`) that capture console, network and branch discrimination on
failure, redacted by construction. This test does not use them, so a recurrence today would again
produce a duration nobody can classify.

**Ruled and settled, not open:** adopting that recorder here was raised and **declined**. #291
authorises measured reproduction/rule-out and a mechanism-backed fix; a 34-run non-reproduction with
no established mechanism closes that scope honestly, and the diagnostics adoption is a separate
evidence-infrastructure change rather than part of this one. If this test fails again, that adoption
is the first thing to do — it is a one-line-per-test change against an existing, already-reviewed
recorder, and it needs its own ticket.

## Security

No credential, token, invite URL or authenticated endpoint appears in any captured artifact. The
capture is filtered to `node:test` summary lines and failure blocks; the retained logs were scanned
for `tgl_`, `Bearer`, `token=`, `authorization` and the fixture token shape, with no matches.
