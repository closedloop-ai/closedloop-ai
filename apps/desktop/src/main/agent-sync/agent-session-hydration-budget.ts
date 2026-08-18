/**
 * @file agent-session-hydration-budget.ts
 *
 * ISS-5988: bound a sync cycle's hydration by BYTES HELD rather than by a
 * candidate count.
 *
 * The sync tick used to hydrate every admitted candidate in one
 * `loadSyncedSessions` call, so peak retained heap scaled with the candidate
 * cap. That is why the cap was pinned at 1: a single transcript-heavy session
 * can hydrate to tens of MiB, and a whole-corpus load is what produced the V8
 * OOM (exit 5) in the first place. Raising the count alone would have scaled
 * that peak linearly — trading the throughput defect for the memory defect.
 *
 * Hydrating in slices and stopping once the accumulated bytes reach the budget
 * decouples the two: the candidate cap becomes a backstop, while peak retained
 * hydration stays near one request's worth no matter how many candidates were
 * admitted.
 *
 * The budget is measured in RAW JSON bytes deliberately, even when the server
 * negotiated gzip. This bound exists to cap the JS heap the hydrated objects
 * occupy, and that cost is the raw object graph — the compressed wire size is a
 * different dimension, already enforced downstream by the byte cap the
 * accumulator packs against.
 *
 * Progress is never sacrificed to the budget: the budget is only consulted
 * AFTER a slice has loaded, so the first slice always hydrates and a session
 * larger than the whole budget still ships (it is chunked downstream) instead
 * of wedging the queue behind a bound it can never satisfy.
 *
 * ⚠️ That escape hatch is `SESSION_HYDRATION_SLICE_SIZE` sessions wide, NOT
 * one. An earlier version of this comment said "a lone session", which
 * understated it by the slice size: with a slice of N, up to N sessions are
 * hydrated before the budget gets a vote, so the true worst-case first load is
 * N x the largest single session, not one of them. Keep the slice size small
 * for exactly this reason — it is the real bound on overshoot, and the byte
 * budget cannot claw back heap that has already been spent hydrating.
 */

import { runAsBackgroundDbReads } from "../database/db-host/db-host-call-priority.js";
import type { SessionAttributionResolverCache } from "./agent-session-attribution.js";
import { rawJsonByteLength } from "./agent-session-sync-compression.js";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";
import {
  SESSION_HYDRATION_BYTE_BUDGET,
  SESSION_HYDRATION_SLICE_SIZE,
} from "./agent-session-sync-limits.js";
import type { AgentSessionSyncSource } from "./agent-session-sync-source.js";

export type HydrationBudgetResult = {
  /** Sessions that hydrated successfully, in admission order. */
  sessions: SyncedAgentSession[];
  /**
   * Candidate ids this pass actually attempted to hydrate. The caller's
   * unhydratable-candidate handling must be scoped to THESE ids, never the full
   * admitted list — an id the budget deferred was never loaded, so treating it
   * as unhydratable would dead-letter a session that is perfectly healthy.
   */
  attemptedIds: string[];
  /** Admitted ids the budget stopped short of; they stay queued for next tick. */
  deferredIds: string[];
  /** Raw JSON bytes of everything hydrated this pass. */
  hydratedBytes: number;
};

export type HydrationBudgetOptions = {
  byteBudget: number;
  sliceSize: number;
  /** Overridable for tests; defaults to raw JSON byte length. */
  measure?: (value: unknown) => number;
};

/**
 * Hydrate `ids` in bounded slices, stopping once `byteBudget` raw bytes have
 * been loaded. Always attempts at least the first slice so the queue advances
 * even when one session exceeds the entire budget.
 */
export async function hydrateWithinByteBudget(
  ids: string[],
  // Mirrors `AgentSessionSyncSource.loadSyncedSessions`, which may answer
  // synchronously, so the source contract passes through unchanged.
  loadSlice: (
    sliceIds: string[]
  ) => SyncedAgentSession[] | Promise<SyncedAgentSession[]>,
  options: HydrationBudgetOptions
): Promise<HydrationBudgetResult> {
  const measure = options.measure ?? rawJsonByteLength;
  const sliceSize = Math.max(1, options.sliceSize);
  const sessions: SyncedAgentSession[] = [];
  const attemptedIds: string[] = [];
  let hydratedBytes = 0;
  let index = 0;

  while (index < ids.length) {
    const slice = ids.slice(index, index + sliceSize);
    const loaded = await loadSlice(slice);
    attemptedIds.push(...slice);
    sessions.push(...loaded);
    hydratedBytes += measure(loaded);
    index += slice.length;
    if (hydratedBytes >= options.byteBudget) {
      break;
    }
  }

  return {
    sessions,
    attemptedIds,
    deferredIds: ids.slice(index),
    hydratedBytes,
  };
}

/**
 * Hydrate one sync tick's admitted candidates under the lane's own byte bound.
 *
 * Wraps {@link hydrateWithinByteBudget} with the sync source call and the two
 * bounds, so the tick body carries a single call rather than the loader closure
 * and both constants — which also keeps the (grandfathered, shrink-only) sync
 * service file from absorbing this block.
 *
 * FEA-2718: hydrates WITHOUT event `data`. The sync payload no longer carries
 * turn text, so loading it only for `sanitizeSessionForSync` to discard is pure
 * waste and needlessly re-pays the FEA-2038 hydration cost.
 * `includeComponentUsage: true` keeps the T-8.6 component-usage lane, which
 * previously rode on `!omitEventData`.
 */
export function hydrateSyncCandidates(
  source: AgentSessionSyncSource,
  ids: string[],
  cache: SessionAttributionResolverCache,
  includeMonitoredSessionActivity = false
): Promise<HydrationBudgetResult> {
  // ISS-6079: this is the cloud-sync drain's corpus-scale read, and it shares
  // the db-host bounded read lane with the Sessions page. Marking it background
  // holds a permit back for interactive reads, so the page can never queue
  // behind the drain. Scoped around the WHOLE budgeted walk, not one slice —
  // every slice it issues is background. See db-host-call-priority.ts.
  return runAsBackgroundDbReads(() =>
    hydrateWithinByteBudget(
      ids,
      (sliceIds) =>
        source.loadSyncedSessions(sliceIds, cache, {
          omitEventData: true,
          includeComponentUsage: true,
          includeMonitoredSessionActivity,
          // ISS-6119: every session this lane hydrates goes through
          // `compactSessionMetadataForSync` -> `compactMetadataForPreview`,
          // which drops `OMITTED_METADATA_KEYS` outright. Hydrating them only to
          // discard them was the largest metadata term on this path.
          omitPreviewStrippedMetadata: true,
        }),
      {
        byteBudget: SESSION_HYDRATION_BYTE_BUDGET,
        sliceSize: SESSION_HYDRATION_SLICE_SIZE,
      }
    )
  );
}
