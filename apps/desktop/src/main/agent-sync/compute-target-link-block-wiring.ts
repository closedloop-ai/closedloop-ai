/**
 * @file compute-target-link-block-wiring.ts
 * @description ISS-11426: the application-level wiring of the compute-target
 * link block — ONE latch, the seams that feed it, and the reader the
 * runtime-status poll calls.
 *
 * A sibling of `app.ts` rather than three blocks inside it. `app.ts` is a
 * grandfathered file under the repo's shrink-only size discipline, and this is
 * the cohesive unit: the tracker, the tee that carries the dashboard runtime's
 * lanes into it, and the accessor the IPC layer reads. Keeping them together
 * also keeps the rationale below with the code it constrains instead of spread
 * across three call sites that each restate half of it.
 *
 * WHY ONE LATCH. Several independent subsystems can be refused
 * `target_not_owned`: the session-metadata and invocation lanes through the
 * sync-lane composition, the transcript lane through the dashboard runtime's
 * `emitSyncBatch` seam. A per-subsystem tracker would let one lane's success
 * clear a block another lane is still hitting, so the alert would flicker on a
 * once-a-second poll and restart its age and count on every refusal.
 *
 * WHICH LANES COUNT IS NOT DECIDED HERE. `LANE_OWNERSHIP_ROLE`
 * (`compute-target-link-block.ts`) decides it once, exhaustively over the
 * closed lane union, so this tee can stay a plain forward. Filtering at each tee
 * would put that judgment in as many places as there are tees; a new lane wired
 * to any of them reds `tsc` at the table instead.
 */

import {
  type ComputeTargetLinkBlockState,
  type ComputeTargetLinkBlockTracker,
  createComputeTargetLinkBlockTracker,
} from "./compute-target-link-block.js";
import type { SyncLaneBatchEmit } from "./sync-lane-cloud-health.js";

export type ComputeTargetLinkBlockWiring = {
  /** Handed to the sync-lane composition, which folds its own lanes into it. */
  tracker: ComputeTargetLinkBlockTracker;
  /** The dashboard runtime's second reader of the batch events it emits. */
  observeSyncBatch: SyncLaneBatchEmit;
  /** What the runtime-status poll answers with; null when nothing is blocked. */
  read: () => ComputeTargetLinkBlockState | null;
};

/**
 * `readOnlineComputeTargetId` is the STRICT-ONLINE read, which is `null` while
 * the socket is down — a window the dashboard lanes deliberately run in. That
 * records a block with an unnamed target rather than a wrong one, and no
 * surface renders the id; the block still clears on the next accepted batch,
 * whichever target that names (whitlockk).
 */
export function createComputeTargetLinkBlockWiring(
  readOnlineComputeTargetId: () => string | null
): ComputeTargetLinkBlockWiring {
  const tracker = createComputeTargetLinkBlockTracker();
  return {
    observeSyncBatch: (event) =>
      tracker.observe(event, readOnlineComputeTargetId()),
    read: () => tracker.read(),
    tracker,
  };
}
