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

// Whether a stored record may be shown as ordinary restored content at all.
//
// `system` is the room's own voice and `status` is its broadcast treatment. A
// hand-edited store must not be able to speak in either, and the answer is to not
// render such a record rather than to render it with the marking stripped —
// exclusion is checkable, a downgrade is one forgotten branch away from failing.
export function isRestorableStoredType(type) {
  return type !== "system" && type !== "status";
}
