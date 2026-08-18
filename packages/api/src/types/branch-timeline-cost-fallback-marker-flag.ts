/**
 * ISS-5951: the single cross-surface flag key gating the Branch PR-activity
 * timeline's honest fallback-cost marker.
 *
 * The headline cost prefers the Branch's authoritative total and falls back to
 * the rendered chartable subtotal for two reasons — incomplete timing evidence,
 * or no authoritative total at all. Only the first was ever marked, so the
 * second rendered a fallback figure that read as authoritative. When ON, the
 * marker follows the SAME predicate that selects the value, so the two cannot
 * disagree.
 *
 * The same predicate also decides the case where the trace evidence never
 * arrived at all: with no completeness evidence in either direction, the cost,
 * LOC/$, and duration read "Unavailable" when ON rather than rendering the same
 * confident figures a confirmed-complete trace produces. OFF keeps the
 * historical figures exactly as they were.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so BOTH surfaces import the SAME literal instead of
 * redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop main process registers it as a Labs toggle via
 *    `DESKTOP_BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`).
 *
 * `BranchDetailPage` mounts on web AND desktop, so a split literal would mark
 * the fallback on one surface and leave the other presenting it as authoritative
 * — the exact leak the ISS-4779 closed-by-default policy requires both gates to
 * prevent.
 */
export const BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY =
  "branch-timeline-cost-fallback-marker" as const;
