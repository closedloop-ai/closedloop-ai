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
  triggerEnrichmentSweep: () => Promise<unknown>;
  onEnrichmentSweepFailure: (error: unknown) => void;
};

/**
 * Runs the runtime-facing DB-host backfill op and applies the renderer
 * invalidation/enrichment decisions from its summary. Marker-touch-only repairs
 * invalidate session projections, while captured artifacts also request the
 * existing enrichment sweep.
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
  if (backfillSummary.captured > 0) {
    options.triggerEnrichmentSweep().catch(options.onEnrichmentSweepFailure);
  }
  return backfillSummary;
}
