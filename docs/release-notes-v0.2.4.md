# v0.2.4

Range: `v0.2.3` (commit `fb577ba`) → `main` (`6e6141d`). Thirteen pull requests
merged since v0.2.3.

This release is mostly about the room you already have open. v0.2.3 made the
suite trustworthy; this one is about the dashboard and the room being usable
when your history is long, your host is offline, or you have more rooms than you
want to click through one at a time.

**One behaviour change to know about before you upgrade:** a copied channel link
is now navigation, not an invite. See *Security* below.

---

## Six things asked for after using v0.2.3

**Manage many rooms at once instead of one at a time (#277, `b146b8f`).**
Joined rooms now open as a full list in the main panel with multi-select, so
archiving or deleting sixty-six test rooms is one action rather than sixty-six.
Previously the only path was the sidebar, one room per confirmation.

**Entering a room is fast again on a long history (#278, `ba93a8d`).**
Entry seeds from the copy this device already saved and fetches only what is
new, instead of re-downloading the entire history from the host every time. On a
room with hundreds of messages this is the difference between a wait and an
instant open. See *Reaching older history* for what you now see on entry.

**Your local transcript is readable when the host is down (#279, `793a323`).**
A room whose host has stopped serving used to be a dead end. The copy on your
device is now shown, clearly marked as local, with what it covers stated rather
than implied.

**The sidebar split is resizable (#275, `4858ae6`).**
The divider has a drag handle and the split position is yours to set.

**The room view keeps its navigation (#276, `0d1c696`).**
Room context, the channel list, and a route back to the dashboard stay on
screen, so a room is somewhere you can navigate *from* rather than a
one-way door.

**A GitHub link beside the sidebar version (#280, `501370f`).**

---

## Reaching older history

**A warm entry shows your most recent messages, with a control to load older
ones (#283, `39f4e61`).**

Because entry now seeds from your device's saved copy (#278), what you see on
opening a room is its newest stretch rather than everything ever posted. The
divider says which messages are on screen, and a **Show earlier messages**
control at the top of the timeline fetches older ones from the host on demand —
one page per click, never in the background. Once older messages load, the
divider updates to describe what is actually shown rather than going stale.

If the host is unreachable, the control is withdrawn and says why: older history
lives only on the host, so a control that could not deliver it would be worse
than none.

Older messages pulled this way are **display-only**. They are not written into
the device's saved copy, which is deliberately bounded to the newest slice — so
asking for old history once does not evict newer messages you will want next
time.

**Host protocol.** `GET /messages` gained a backward read: optional `before_id`
with a client-supplied `limit`, returning an explicit `has_more_before` so
completeness is stated rather than guessed from a short page. `since_id`
semantics are unchanged, so existing callers — the CLI, `/wait` — are
unaffected. Sending `since_id` and `before_id` together is rejected, and an
absent `limit` still means unbounded.

---

## Security

**A copied channel link is no longer an invite (#276, `0d1c696`, closing #288).**

Channel navigation URLs used to carry your session token in the fragment. That
kept it out of server logs but still placed a bearer credential in the rendered
markup, where any script or extension on the page could read it off the DOM. It
is gone.

**What this changes for you:** a channel link you copy and paste into a fresh
browser session will land **unauthenticated** and ask for an invite. That is the
fix working as intended, not a bug. Switching channels in your own tab is
unaffected — that navigation is same-origin and same-tab, and the credential is
already there.

If you land unauthenticated on a device that has used its dashboard before, the
room now offers a route back to it rather than only telling you to ask the host
(#290, `af83e5f`).

**The remembered dashboard address is reduced to its origin before it is used
(#299, `af83e5f`).** The stored value was validated for scheme and host but
handed back with its path, query and fragment intact, so a stored address could
carry chosen parameters — including a token-shaped fragment — into a link you
are invited to click. It is now canonicalised inside the validator, so every
consumer gets the safe form and a future one cannot reintroduce the problem by
forgetting to strip it. This also fixed the older, wider instance of the same
defect in the dashboard route-home link, which shipped in v0.2.1–v0.2.3.

---

## Correctness

**A damaged offline snapshot no longer reads as "nothing saved" (#293,
`f02021a`).** Unreadable and absent were the same state on screen, which is the
worst way to be wrong: it tells you there is nothing to recover when there is
something that failed to load. They are now distinct.

**The offline notice names both sources (#297, `0432d6f`).** With host-fetched
older messages on screen alongside your saved copy, the notice described only
the saved copy. It now describes what is actually in front of you.

---

## Internal

Not user-visible, recorded so the changelog reconciles against the merge list.

- **Failure-only browser diagnostics (#289, `f7b65a4`; #303, `6e6141d`).** When
  a browser test fails, it now writes a redacted diagnostic record — no headers,
  no request or response bodies, no tokens — and a failing run states whether
  the recorder was attached at all, so a missing artifact is a fact rather than
  a silence. #303 extended this from three files to every browser and e2e test
  file that has a wait able to consume the 30-second ceiling.
- **e2e tunnel investigation (#291, `2f9530b`).** A documented non-reproduction:
  34 runs, no recurrence, and the recorded observation classified as a different
  failure class from the one the ticket assumed. No cause claimed and no fix
  made, because none was established.

---

## Merge reconciliation

Thirteen merges, derived with `git log --merges v0.2.3..HEAD`:

| Merge | PR | Closes |
| --- | --- | --- |
| `6e6141d` | #304 | #303 |
| `2f9530b` | #301 | #291 |
| `0432d6f` | #300 | #297 |
| `af83e5f` | #298 | #290, #299 |
| `f7b65a4` | #295 | #289 |
| `39f4e61` | #296 | #283 |
| `f02021a` | #294 | #293 |
| `4858ae6` | #292 | #275 |
| `0d1c696` | #286 | #276 |
| `793a323` | #285 | #279 |
| `501370f` | #284 | #280 |
| `ba93a8d` | #281 | #278 |
| `b146b8f` | #282 | #277 |

**#288 has no merge of its own, and that is not an omission.** Its mechanism —
removing the session token from rail URLs — was implemented inside #276's PR,
reverted there on scope grounds, then reapplied on the operator's ruling before
that PR merged. #288 was closed as completed at the moment `0d1c696` landed. A
later reader looking for a `#288` merge will not find one; this is why.
