/**
 * @file residual-selector.ts
 * @description FEA-2274 (PRD-488): the pure, shared definition of the classifier
 * RESIDUAL set — the `other`/below-confident-threshold segments the linguistic
 * layer is allowed to look at. This is the ONE boundary both the offline
 * distillation harness and any future opt-in runtime fallback reason about, so
 * "what counts as residual" lives here once rather than being re-derived.
 *
 * Residual = the spend FEA-2269 refused to force-fit: a segment that is NOT
 * `idle` (a labelled gap carries ~no spend and is not improvable) AND is either
 * the honest `other` bucket OR sits below the Q-003 "confident" threshold. The
 * threshold is imported from the FEA-2266 metric module (the Q-003 SSOT) rather
 * than re-encoded, so a threshold change moves both Coverage and residual
 * selection together and they can never drift.
 *
 * Pure/in-memory: no DB, no fs, no session iteration — a total predicate over a
 * single segment's `{ phase, confidence }`.
 */
import {
  confidenceBucketFor,
  isConfident,
} from "../../../telemetry/attribution-metrics.js";
import { ACTIVITY_PHASE, type ActivityPhase } from "../activity-taxonomy.js";

/**
 * The minimal segment shape the residual predicate needs: the taxonomy `phase`
 * and the raw classifier `confidence` (0..1). A structural type (not the full
 * `ActivitySegmentRecord`) keeps this a leaf that the harness, the metric layer,
 * and a future runtime fallback can all satisfy without importing the classifier;
 * `phase` still uses the `ActivityPhase` leaf type (already imported here) so a
 * caller passing a non-taxonomy value fails at compile time.
 */
export type ResidualCandidate = {
  phase: ActivityPhase;
  /** Raw classifier confidence (0..1), bucketed via the FEA-2266 Q-003 cut-points. */
  confidence: number;
};

/**
 * True when a segment is residual — spend the deterministic classifier left
 * unclaimed and the linguistic layer may examine. `idle` is never residual (it
 * is a labelled gap, not unclassified work); `other` always is; any other phase
 * is residual only when its confidence bucket is below the Q-003 confident floor.
 */
export function isResidualSegment(segment: ResidualCandidate): boolean {
  if (segment.phase === ACTIVITY_PHASE.Idle) {
    return false;
  }
  if (segment.phase === ACTIVITY_PHASE.Other) {
    return true;
  }
  return !isConfident(confidenceBucketFor(segment.confidence));
}

/**
 * The residual subset of a session's segments, preserving input order. Generic so
 * callers keep their own richer segment type (spend, spans, prose) on the way
 * through.
 */
export function selectResidualSegments<T extends ResidualCandidate>(
  segments: readonly T[]
): T[] {
  return segments.filter((segment) => isResidualSegment(segment));
}
