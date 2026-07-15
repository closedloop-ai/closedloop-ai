import {
  type ActivitySegmentBackfillResult,
  backfillChangedActivitySegmentProjection,
} from "./activity-segment-backfill.js";
import {
  type DbChangedWindow,
  notifyDbChanged,
} from "./backfill-runtime-window.js";

type ActivitySegmentBackfillRuntimeBoundaryOptions = {
  invokeStoreOp: (name: string, args?: unknown[]) => Promise<unknown>;
  shouldContinue: () => boolean;
  getWindow: () => DbChangedWindow | null;
};

/**
 * Runs the runtime-facing DB-host activity-segment backfill op and invalidates
 * the renderer session projection when any session was re-tiled. Unlike the
 * artifact-link boundary there is no enrichment sweep to trigger — segments are
 * a pure local derivation with no git/gh follow-up.
 */
export async function runActivitySegmentBackfillRuntimeBoundary(
  options: ActivitySegmentBackfillRuntimeBoundaryOptions
): Promise<ActivitySegmentBackfillResult | null> {
  const backfillSummary = (await options.invokeStoreOp(
    "activitySegments.backfill"
  )) as ActivitySegmentBackfillResult;
  if (!options.shouldContinue()) {
    return null;
  }
  if (backfillChangedActivitySegmentProjection(backfillSummary)) {
    notifyDbChanged(options.getWindow());
  }
  return backfillSummary;
}
