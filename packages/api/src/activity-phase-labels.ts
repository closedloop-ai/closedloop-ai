/**
 * ISS-4790 — the SINGLE source of truth for the user-facing label of every
 * activity-taxonomy phase, including the two catch-all buckets.
 *
 * Before this module the same catch-all bucket was spelled three different ways
 * across sibling breakdown surfaces ("Other" on branch detail,
 * "Other / unclassified" in the session activity phase map, and a fourth
 * hand-copied "Other / unclassified" literal inside the session breakdown
 * fallback), so one concept read as three.
 *
 * It lives in `@repo/api` — not in `@repo/app` — because the label has FIVE
 * consumers spanning two dependency layers, and `@repo/lib` cannot import
 * `@repo/app`:
 *   - the session breakdown display map (`@repo/app` `session-activity-phases`),
 *   - the branch bar display map (`@repo/app` `activity-taxonomy-display`),
 *   - the session activity strip (`@repo/app` `session-activity-segments`),
 *   - the strip's legend, and
 *   - `phaseLabel()` in `@repo/lib/sessions/activity-segment-aggregation`, which
 *     serializes `ActivitySegment.label` onto the wire for API consumers.
 * Landing the map under `@repo/app` alone left that fifth (wire) site behind and
 * moved the drift one layer down instead of killing it. Both per-surface DISPLAY
 * maps take their labels from here and own only their own COLORS, which
 * legitimately differ (the session strip and the branch bar use different
 * palettes).
 *
 * Deliberately zero-dependency: this is imported by `"use client"` components on
 * both the web and desktop surfaces, so it stays a lightweight constants module
 * with no parser/validation imports (see AGENTS.md, "Keep shared constants and
 * display-label maps in lightweight modules").
 *
 * Keys are the shared phase keys from `@repo/lib` — `OTHER_PHASE_KEY` /
 * `IDLE_PHASE_KEY` (`@repo/lib/sessions/activity-segment-aggregation`) and
 * `UNATTRIBUTED_KEY` (`@repo/lib/branches/activity-rollup`). Those constants are
 * NOT imported here (`@repo/api` is the lower layer — importing them would
 * invert the dependency direction, and it would pull their modules into every
 * client bundle that only wants a string); `activity-phase-labels.test.ts` in
 * `@repo/lib` pins the alignment instead, so a rename of either key fails a test
 * rather than silently orphaning a label.
 *
 * `other` and `unattributed` are NOT the same bucket and must never collapse
 * into one label: per `@repo/lib/branches/activity-rollup`, `other` is spend the
 * classifier tiled but could not classify, while `unattributed` is spend the
 * classifier never saw at all (no tiling, or a within-session gap). They render
 * as separate rows in the same branch panel, so they need separate words.
 */

export const ACTIVITY_PHASE_LABEL = {
  explore: "Explore",
  plan: "Plan",
  implement: "Implement",
  review: "Review",
  validate: "Validate",
  rework: "Rework",
  idle: "Idle",
  /**
   * The catch-all: work the classifier tiled but could not put in a named phase.
   * Single word on purpose — every sibling row in the same legend is one word,
   * and "Other" is the ordinary catch-all convention in a breakdown. The old
   * "Other / unclassified" was the only compound label in the set, and the slash
   * read as two buckets rather than one.
   */
  other: "Other",
  /**
   * Spend/time with no attribution evidence at all — the classifier never saw
   * it. Distinct from {@link ACTIVITY_PHASE_LABEL.other} so the UI never claims
   * we classified something we never observed.
   */
  unattributed: "Unattributed",
} as const;

/** Label for a phase key outside the known taxonomy but still unnameable. */
export const UNKNOWN_ACTIVITY_PHASE_LABEL = "Unknown";
