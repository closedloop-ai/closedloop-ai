/**
 * @file db-host-close-sequence.ts
 * @description ISS-6003 — the order in which the db-host tears itself down on
 * `Close`, extracted from `db-host-worker.ts` because that module registers a
 * `process.parentPort` listener at load and so cannot be imported by a test.
 *
 * The order is the contract. Main posts `Close` and kills the child after
 * `CLOSE_ACK_TIMEOUT_MS` (2s, `db-host-client.ts`), and closing the store drains
 * the write queue — so while a multi-second import holds that queue, the store
 * close outlives the budget and everything sequenced behind it is lost. The
 * ISS-4430 CPU-profile write used to sit there, which meant a profiling run
 * captured nothing in exactly the busy state it exists to measure. Nothing about
 * writing the profile depends on the store, and the store close was already
 * best-effort, so the diagnostics artifact goes first.
 */

export type DbHostCloseSteps = {
  /**
   * ISS-4430 profile flush. Absent unless `CLOSEDLOOP_PROFILE_DIR` is set, which
   * is why re-ordering it ahead of the store close costs a production launch
   * nothing. Best-effort: a failed write never stops the store close below it.
   */
  stopProfiling?: () => Promise<void>;
  /** Store teardown. Best-effort: a failure never stops the process exiting. */
  closeDatabase?: () => Promise<void>;
};

/**
 * Flush diagnostics, then close the store. Never rejects — the caller exits the
 * process next either way.
 */
export async function runDbHostCloseSequence(
  steps: DbHostCloseSteps
): Promise<void> {
  try {
    await steps.stopProfiling?.();
  } catch {
    // Diagnostics are best-effort too: a failed profile write must not skip the
    // store close, which is what the old order guaranteed.
  }
  try {
    await steps.closeDatabase?.();
  } catch {
    // Closing best-effort; we exit regardless.
  }
}
