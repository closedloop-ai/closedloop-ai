/**
 * ISS-10467 (operator ruling, marisolashgrove 2026-09-26): the ONE sentence that
 * says a component-scoped figure was measured at SESSION level.
 *
 * Hoisted out of `componentMetrics`, where it shipped as the `LOC / $` card's
 * `info.how` literal, because the per-version token and cost rows carry exactly
 * the same caveat for exactly the same reason: a session that ran this revision
 * also ran everything else in it, so each co-invoked component's usage row is
 * given the session's FULL cost and FULL token count
 * (`isLocPerDollarVerifiableKind` states the attribution problem in full). Two
 * surfaces making that admission in two different sentences is how one of them
 * gets softened later while the other still means it.
 *
 * NOT a new phrase — the string is unchanged from the card that already ships it.
 */
export const SESSION_LEVEL_ATTRIBUTION_CAVEAT =
  "A session-level metric, so read it as directional. One component doesn't cause it.";
