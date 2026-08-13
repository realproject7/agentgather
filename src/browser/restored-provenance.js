// How a locally-stored record may be presented — one decision, two surfaces
// (#278, #279).
//
// The room page and the owner dashboard render stored records through separate
// renderers, and they stay separate on purpose: they emit different DOM for
// different affordances (the room has replies, avatars and markdown; the dashboard
// has plain read-only rows), and they are served to different origins by different
// servers. Merging them would be a refactor of two live surfaces well outside the
// ticket that needs this.
//
// What they must never differ on is PROVENANCE. #278 established the rules on the
// room page; the dashboard rendered the same stored records with none of them, and
// nothing structural stopped the two from drifting further apart. So the rules live
// here and both import them: a change to how restored content may be attributed
// changes both surfaces or neither.

// What a restored row says instead of a stored alias. Fixed, because the only
// authorship a device can vouch for is "this came from my own copy" — a stored
// alias resolved against a live roster would confer an identity the record has not
// earned, which is exactly the laundering #278 closed.
export const RESTORED_SENDER_LABEL = "local copy";

// The ONLY way a restored row may show an author (#312).
//
// #279's rule was written for the case where nothing can check the store: the host
// is gone, and a stored alias resolved against a live roster would confer an
// identity the record has not earned. That reasoning is untouched. #278 then routed
// a SECOND case through it — a warm entry while the host is reachable and serving
// the very ids being seeded — where attribution is not an unverifiable claim
// because the host's own log can confirm it row by row.
//
// So this takes the HOST's record and nothing else. That is the whole guarantee,
// and it is structural rather than remembered: the stored alias is never passed in,
// so no future caller can be talked into rendering it. A caller with no host record
// for THIS id gets the label back — "the host answered something" is not
// confirmation of a row, and a healthy connection confers nothing.
//
// DASHBOARD (deliberate, not drift): the dashboard renders the offline snapshot,
// which exists precisely because the host is NOT reachable. It therefore has no
// host record to pass and always receives `null` here, so it keeps `local copy`
// exactly as before. The shared rule changes for both surfaces; the outcome differs
// only because one of them can obtain confirmation and the other, by definition,
// cannot.
export function confirmedRestoredSender(hostRecord) {
  if (hostRecord === null || typeof hostRecord !== "object") return RESTORED_SENDER_LABEL;
  const from = hostRecord.from;
  if (typeof from !== "string" || from.length === 0) return RESTORED_SENDER_LABEL;
  return from;
}

// Whether a stored record may be shown as ordinary restored content at all.
//
// `system` is the room's own voice and `status` is its broadcast treatment. A
// hand-edited store must not be able to speak in either, and the answer is to not
// render such a record rather than to render it with the marking stripped —
// exclusion is checkable, a downgrade is one forgotten branch away from failing.
export function isRestorableStoredType(type) {
  return type !== "system" && type !== "status";
}
