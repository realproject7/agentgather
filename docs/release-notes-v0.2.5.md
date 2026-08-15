# v0.2.5

Range: `v0.2.4` (commit `21fe601`) → `main` (`d22169a`). Ten merge commits since
v0.2.4: eight product pull requests and two branch-integration merges.

A patch release about being told the truth by the surfaces you already use. A
warm room entry now says which of your messages the host has actually confirmed
and which are only your device's copy. The dashboard says which seat a joined
room will open you as *before* you open it. Two CLI commands that failed with a
raw `ENOENT` now name the condition they hit and what to do about it. The rest
of the range is test and diagnostics work: it does not change the product, but
it is why the range above is trustworthy, so it is described rather than
summarised away.

No dependency, contract, or protocol changes. Upgrading is a version bump.

---

## Your room says which messages the host has confirmed

**A warm entry no longer labels every seeded message `local copy` while the host
is live (#312, `8c2d263`).**

Since v0.2.4, opening a room seeds the timeline from the copy your device
already saved and fetches only what is new. Every seeded row was rendered as
`local copy` — including rows the live host was serving at that very moment. The
label was correct in v0.2.4's original case (the host is gone, and nothing can
check the store) and wrong in the case v0.2.4 then routed through it.

A seeded row now earns its author from **the host's own record for that exact
row**, or keeps saying `local copy`. Not from the alias stored on your device,
and not from the host merely being reachable — the confirmation is row by row,
and the stored alias is never passed to the renderer at all, so no future caller
can be talked into displaying it (`src/browser/restored-provenance.js`). A host
record that cannot itself be restored does not confirm anything.

The dashboard's offline snapshot exists precisely because the host is *not*
reachable, so it has no host record to offer and keeps `local copy` throughout.
Both surfaces now import one set of provenance rules rather than each carrying
its own.

## The dashboard says which seat a room opens as, before it opens

**Joined rows disclose their seat identity, and let you choose it (#311,
`b091e87`).**

A human's dashboard had no concept of whose it was. Rooms joined under an
agent's home opened you as that agent — an agent *host* seat — with nothing on
screen saying so until you were already inside.

Each joined row now states the seat the click would actually take: an **Agent
seat** badge where that is what will happen, and a seat description on the row's
own accessible name so it is announced rather than only shown
(`src/browser/shell.js:644`). Where the row holds more than one credential, the
row offers the choice inline, and the badge and description follow the choice
rather than describing a seat you are no longer taking. A credential that has
gone away stops counting, so the disclosure cannot outlive the seat it names.

Only the agent seat is marked. A human seat and an unknown legacy row are left
unbadged deliberately — a badge on every row would make the one that matters
invisible.

## Two CLI failures now name the condition instead of a file path

**A host-only command run in a participant-only home (#310, `acc40db`).**
`agentgather room <host-only command>` in a home that merely *joined* the room
used to surface a raw `ENOENT` on an internal file. It now says the command is
host-only, which of the three conditions it hit — no current room, an unknown
room, or a participant copy of that room — and where to run it instead
(`src/cli/commands/room/host-home.ts:84`). Read-only `runtime-status` stays
usable in a participant home, and that is pinned by a test rather than left to
convention.

**A participant `room leave` (#314, `d22169a`).** Leaving used to read the
host's files directly and fail with a raw `ENOENT` on a participant device that
by definition has none of them. `leave` now goes through the host's own server —
the endpoint that already exists — and a refusal is reported in `room leave`'s
own words: the command named, your state in your terms, the dashboard remedy,
and the host's reason as trailing context on its own labelled line.

The host's reason is text this device did not write, so it is treated that way:
credentials, token-bearing URLs and bearer-shaped values are redacted, then
whitespace is collapsed, then the result is capped — in that order, so the cap
applies to the whole reason and a newline cannot push host-supplied text below
the message's own lines where it would read as ours.

---

## For anyone running the suite

Not user-visible. Recorded because the range reconciles against these merges,
and because #319 is why the release's CI history reads the way it does.

- **The browser suite no longer writes into your real `~/.agentgather` (#305,
  `0bcf5c2`).** A suite run had put 66 joined-room rows into the developer's
  actual home by addressing the product's default endpoints. The default ports
  are centralised so composition cannot bypass the guard, all four loopback
  spellings the product accepts are guarded, and the scan walks the e2e and
  support trees to any depth — with a test that proves the walk rather than
  assuming it.
- **Failure diagnostics classify escaped test titles correctly (#318,
  `10b41cb`).** A failing test was matched by its source spelling, so any title
  containing an escape was reported as outside the browser wait surface. It is
  now matched by its parsed title.
- **An unresolved wait title fails loud and located (#322, `38e5fde`).** A
  browser block whose runtime name could not be resolved used to leave the wait
  surface silently, which reads identically to having no such block. It now
  fails with its location, and the header says the refusal is deliberate.
- **#319's assertion no longer races the confirmation pass (#321, `e141c9e`).**
  The intermittent `#278` restored-record render timeout on `main` was a stale
  test premise, not a product defect: the test forged a row at an id the room
  really had and waited for the forged text, which #312's confirmation pass
  correctly erases. In isolation the wait won that race; under load it lost it.
  The test now waits on the confirmation marker and asserts after the pass, with
  no wait raised, loosened, skipped or sleep-padded. See *Release validation* —
  this test's failures across the range are recorded there rather than rounded
  off.

---

## Merge reconciliation

Ten merges, derived with `git log --merges v0.2.4..HEAD`:

| Merge | PR | Closes |
| --- | --- | --- |
| `d22169a` | #326 | #314 |
| `c25e6ba` | — | integration only |
| `e141c9e` | #321 | #319 |
| `38e5fde` | #324 | #322 |
| `8995421` | — | integration only |
| `10b41cb` | #320 | #318 |
| `0bcf5c2` | #316 | #305 |
| `b091e87` | #317 | #311 |
| `8c2d263` | #315 | #312 |
| `acc40db` | #313 | #310 |

**The two rows with no PR are `main` being merged into a branch, not features.**
`8995421` brought #318's landed diagnostics fix into #319's branch; `c25e6ba`
brought #319's landed fix into #314's branch. Both carry only the sibling's
already-merged diff and neither closes an issue — they are listed because the
range contains them, not because they shipped anything of their own.

**PR #325 is not in this range and is not an omission.** It was an authorized
no-op control for the #319 investigation, closed without merge; it remains the
evidence record for that investigation and shipped no code.

---

## Release validation

**CI for #319 and #314 was not clean on the way in, and is recorded here in
full.** The two branches went red on **two different tests**, and keeping them
apart is the point: #314's reds are the `#278` restored-record render timeout —
the defect #319 exists to fix — while #319's own reds are the `#268` no-POST
timeout, a separate failure now owned by #323 and not addressed in this release.
One of the greens below is also a rerun of an unchanged commit. Both facts are
named rather than rounded off.

**#319 / PR #321** (`task/319-restored-record-render-timeout`):

| Run | Commit | Attempt | Result | Failing test |
| --- | --- | --- | --- | --- |
| `31668708072` | `431da78` | 1 | fail | `Send before entry completes cannot navigate or eject the participant (#268)` (30.5s) |
| `31671503503` | `8995421` | 1 | fail | same `#268` test (30.5s) |
| `31671503503` | `8995421` | 2 | **pass** | — |

The green that gated #321's merge is **attempt 2 of an unchanged commit**, not a
first-pass green. Its failing predecessor is the `#268` no-POST signature, a
different failure from the one #319 fixes; that signature is now owned by #323
and is not addressed in this release.

**#314 / PR #326** (`task/314-leave-participant-state`):

| Run | Commit | Attempt | Result | Failing test |
| --- | --- | --- | --- | --- |
| `31679369894` | `e6eceb6` | 1 | pass | — |
| `31679863623` | `20b1ff3` | 1 | fail | `no restored record's author or text escapes into an unmarked surface (#278)` (30.5s) |
| `31680775426` | `ea7d2de` | 1 | pass | — |
| `31681561057` | `ae70115` | 1, 2, 3 | fail ×3 | same `#278` test, all three attempts |
| `31684702422` | `c25e6ba` | 1 | **pass** | — |

Three recorded attempts at `ae70115` all failed on the same test, so at that
commit the failure was deterministic, not intermittent. The final green is at
`c25e6ba` — a genuinely different commit that merged `main` and therefore
carried #319's landed fix — and not a reroll of the red one. The reruns were
authorized case by case with each attempt recorded; nothing here should be read
as a licence to rerun a failing gate until it passes.

**Gates at the release commit** are recorded in the release-source PR that closes
#327 — build, lint, typecheck, kit-guard, no-stub, the full local suite, and
`npm pack --dry-run` — including exact counts and any test that did not pass.

---

## Publishing

`npm publish` is the operator's gate and has not been run by an agent. This
release's source — the version triplet and this document — is merged through the
ordinary review and CI gate and stops there. After the operator publishes, the
registry version is verified, the final `main` commit is tagged `v0.2.5`, and
the GitHub Release is created on that commit.
