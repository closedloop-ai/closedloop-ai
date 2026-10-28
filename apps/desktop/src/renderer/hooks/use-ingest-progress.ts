import {
  type MaintenanceProgress,
  parseMaintenanceProgress,
} from "./parse-maintenance-progress";
import {
  readRuntimeStatus,
  useRuntimeStatusValue,
} from "./use-runtime-status-poll";

export type HarnessIngest = {
  harness: string;
  total: number;
  processed: number;
};
export type IngestProgress = {
  byHarness: HarnessIngest[];
  total: number;
  processed: number;
  // A first-pass import has begun but the source scan has not yet produced a
  // total; the banner shows an indeterminate "preparing" state for this.
  preparing: boolean;
  /**
   * ISS-5281: the main process reporting that every first pass it began has
   * ENDED, no source scan is running, and nothing was left for retry. The banner
   * needs this producer-owned answer because the equivalent renderer-side
   * inference (`processed >= total && !preparing`) is not the same claim — see
   * `IngestProgressSnapshot.drained` for the three reachable ways it lies.
   * Optional so an older main process that never sends the field degrades to
   * `undefined`, treated as NOT drained: the splash then reports the stall as a
   * failure exactly as it did before, which is the honest direction when we
   * cannot prove the queue emptied.
   */
  drained?: boolean;
  // ISS-5115: the import loop has ACKNOWLEDGED a user pause by actually parking
  // on its pause gate. `paused` in the UI is a request; this is the collector
  // confirming it stopped. They diverge for as long as the loop takes to reach
  // its next gate, which during first-launch source discovery is the whole scan.
  // Optional so an older main process that never sends the field degrades to
  // `undefined` — treated as "not yet acknowledged", which under-claims and is
  // the safe direction.
  importParked?: boolean;
  // Every harness's boot import has finished. The banner relies on this rather
  // than aggregate `processed >= total`, which is briefly true between the
  // staggered per-harness passes.
  complete: boolean;
  // FEA-4156: the boot import gave up without settling — a harness import wedged
  // and the main-process watchdog timed out. Distinct from `complete`: no
  // post-boot maintenance runs, and the splash resolves into its graceful
  // partial-import (failed) state. Optional so an older main process that never
  // sends the field degrades to `false` (undefined) rather than mis-reporting.
  timedOut?: boolean;
  // ISS-6207: the boot import SETTLED but at least one harness gave up with
  // source files outstanding after its bounded automatic re-drive budget was
  // spent. A third terminal claim, distinct from both siblings: unlike
  // `complete` the work did not finish, and unlike `timedOut` the import is no
  // longer running. No post-boot maintenance and no cloud-read cutover run on
  // it. Optional so an older main process that never sends the field degrades to
  // `undefined` — treated as NOT exhausted, which is the pre-ISS-6207 reading
  // and never invents a degraded state we cannot prove.
  retriesExhausted?: boolean;
  // ISS-4444: transcripts quarantined after their parse wedged repeatedly (a
  // CPU-spinning parser on a poison transcript). The boot import COMPLETES with
  // these skipped; the count lets the summary honestly surface "N transcripts
  // couldn't be read" instead of silently under-counting. Optional so an older
  // main process that never sends the field degrades to `undefined` (treated as 0).
  quarantinedCount?: number;
  // ISS-6115: the same population split by the stage that quarantined it. The
  // count above changed meaning when the import bound started charging the
  // quarantine store — an import stall means the transcript WAS read and its
  // WRITE did not finish — so "couldn't be read" is only true of `parse`.
  // Optional and per-key optional: an older main process sends neither, which
  // `resolveQuarantinedStageCounts` degrades to the pre-ISS-6115 reading (the
  // whole population attributed to `parse`, which is what it was).
  quarantinedByStage?: { parse?: number; import?: number };
};

// FEA-2264: the post-boot maintenance phase the main process is currently
// running (data-revision rebuild, then artifact-link backfill), or none.
// ISS-6241 moved the shape and its validation to `parse-maintenance-progress.ts`
// once it began carrying counts the splash does arithmetic on; re-exported here
// so existing importers keep resolving.
export type { MaintenanceProgress } from "./parse-maintenance-progress";

/**
 * Project the first-pass ingest progress out of the runtime-status payload, or
 * null when it is absent (the Agent Dashboard runtime is not up yet). Shared by
 * the first-launch dashboard loading treatment and the app-wide import banner so
 * the two never drift.
 */
export function parseIngest(status: unknown): IngestProgress | null {
  return readRuntimeStatus(status).ingest ?? null;
}

/**
 * Project the post-boot maintenance phase out of the runtime-status payload, or
 * null when the field is absent (older main process, or the Agent Dashboard
 * runtime is not up yet). The first-launch banner treats null as "no
 * maintenance" rather than latching the calm state on.
 */
export function parseMaintenance(status: unknown): MaintenanceProgress | null {
  // ISS-6241: validated, not cast. The payload now carries the numerator and
  // denominator the Compute step renders, so an unvalidated shape is how a
  // total the pass cannot substantiate reaches the screen.
  return parseMaintenanceProgress(readRuntimeStatus(status).maintenance);
}

/** Polls the main-process ingest progress while `active`. */
export function useIngestProgress(active: boolean): IngestProgress | null {
  return useRuntimeStatusValue(active, parseIngest);
}

/**
 * Polls the main-process post-boot maintenance phase while `active`. Returns
 * null until the first response (and whenever the field is absent), so the
 * banner treats "unknown" as "no maintenance" rather than latching the calm
 * state on. Defensive against a missing `desktopApi` (test/SSR contexts).
 */
export function useMaintenanceProgress(
  active: boolean
): MaintenanceProgress | null {
  return useRuntimeStatusValue(active, parseMaintenance);
}
