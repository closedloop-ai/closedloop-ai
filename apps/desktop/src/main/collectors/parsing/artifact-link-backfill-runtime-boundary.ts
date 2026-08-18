import {
  type BackfillResult,
  backfillChangedSessionProjection,
} from "./artifact-link-backfill.js";
import {
  type DbChangedWindow,
  notifyDbChanged,
} from "./backfill-runtime-window.js";

export type ArtifactLinkBackfillRuntimeBoundaryOptions = {
  invokeStoreOp: (name: string, args?: unknown[]) => Promise<unknown>;
  shouldContinue: () => boolean;
  getWindow: () => DbChangedWindow | null;
};

/**
 * Runs the runtime-facing DB-host backfill op and applies the renderer
 * invalidation decision from its summary: a marker-touch-only repair still
 * invalidates session projections.
 *
 * PLN-1535 M5: this also used to request an enrichment sweep when the backfill
 * captured artifacts. Its only production caller passed a `() =>
 * Promise.resolve()` stub, so the request reached nothing; D6 deleted the sweep
 * and this hook with it. GitHub fields on captured artifacts are filled by the
 * cloud projection.
 */
export async function runArtifactLinkBackfillRuntimeBoundary(
  options: ArtifactLinkBackfillRuntimeBoundaryOptions
): Promise<BackfillResult | null> {
  const backfillSummary = (await options.invokeStoreOp(
    "artifactLinks.backfill"
  )) as BackfillResult;
  if (!options.shouldContinue()) {
    return null;
  }
  if (backfillChangedSessionProjection(backfillSummary)) {
    notifyDbChanged(options.getWindow());
  }
  return backfillSummary;
}
