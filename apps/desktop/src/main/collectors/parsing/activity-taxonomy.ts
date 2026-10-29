/**
 * @file activity-taxonomy.ts
 * @description FEA-2269 (PRD-488): the structural scorer's phase order. The
 * taxonomy itself is `@repo/api/src/types/activity-phase` (ISS-12552), shared
 * with `@repo/lib`; this leaf module keeps only the scorer's order so the
 * classifier and the scorers import it without an import cycle.
 */

import {
  ACTIVITY_PHASE,
  type ActivityPhase,
} from "@repo/api/src/types/activity-phase";

/**
 * The active-work phases in a fixed, deterministic order. Two uses, both
 * load-bearing for determinism:
 *  1. It is the argmax tie-break — when two phases score equal, the earlier entry
 *     wins, so a tie always resolves to the SAME phase (never argmax/Map
 *     iteration order).
 *  2. The scorer maps this array 1:1 onto its per-phase score functions.
 * Excludes `other` (the sub-floor fallback) and `idle` (a gap kind the store
 * owns), plus the DECLARED-only labels `review` and `rework` (assigned by
 * post-passes, never argmax'd) — none of which is ever a scored label.
 */
export const ACTIVE_PHASE_ORDER = [
  ACTIVITY_PHASE.Explore,
  ACTIVITY_PHASE.Plan,
  ACTIVITY_PHASE.Implement,
  ACTIVITY_PHASE.Validate,
] as const satisfies readonly ActivityPhase[];
