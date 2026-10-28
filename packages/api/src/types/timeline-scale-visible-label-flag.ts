/**
 * ISS-10599: the single cross-surface flag key gating the VISIBLE label on the
 * timeline scale toggle.
 *
 * WHAT IT GATES. `TimelineScaleControl` names itself to assistive tech and to
 * nobody else: its group name reached `aria-label` only. A sighted reader saw a
 * bare row of duration pills (`5m 15m 1h 12h`) with nothing separating it from
 * `DateRangeFilter`'s own bare duration pills (`7d 30d 90d All`) elsewhere in
 * the product, so a coarse `12h` bin read as "showing a 12-hour window" rather
 * than "12-hour bars". When ON, the group carries the same visible leading
 * label its sibling `TimelineGroupByControl` already does, and the group's
 * accessible name comes from that rendered text via `aria-labelledby`. When OFF
 * the control renders exactly as it shipped, `aria-label` and all — so the
 * accessible name is identical in both states and only the visible text moves.
 *
 * ONE KEY, EVERY SHELL. `TimelineScaleControl` is mounted by the Session
 * Timeline and the Branch PR activity timeline, which the web shell and the
 * desktop renderer both render; the desktop renderer resolves the signed-in
 * account's PostHog assignment from the same key space `apps/app` reads, so
 * this literal is the whole gate and there is no desktop registry entry or Labs
 * toggle beside it. Default OFF on both (ISS-4779 closed-by-default).
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so a bundle-sensitive client surface can import the
 * literal without pulling a parser in.
 */
export const TIMELINE_SCALE_VISIBLE_LABEL_FLAG_KEY =
  "timeline-scale-visible-label" as const;
