/**
 * @file post-boot-maintenance-settle.ts
 * @description Readiness-signal settling for post-boot maintenance.
 *
 * Post-boot maintenance (data-revision rebuild → artifact-link backfill →
 * activity-segment backfill) is best-effort background re-derivation, NOT a gate
 * on dashboard usability — the dashboard data is served independently. The
 * "initial collector import complete" readiness signal that clears the Dashboard
 * nav throbber must therefore fire when maintenance SETTLES for the active
 * generation — whether it succeeds OR fails. Previously it fired only on the
 * success (`.then`) path with no `.catch`, so a rejected maintenance run left the
 * throbber "preparing" forever (and produced an unhandled rejection).
 *
 * Generation/supersede semantics are preserved: `isActive(generation)` gates the
 * settle so a superseded generation (a newer scheduled run owns the signal) does
 * NOT fire. The finalizer always runs, regardless of outcome or generation.
 */

export type PostBootMaintenanceSettleHandlers = {
  /**
   * Runs when maintenance settles (resolve OR reject) AND `isActive(generation)`
   * still holds — i.e. this generation still owns the readiness signal. This is
   * where `onInitialCollectorImportComplete` / `notifyCollectorImportSettled`
   * fire to clear the Dashboard nav throbber.
   */
  onSettleActive: (generation: number) => void;
  /** Whether `generation` is still the active (non-superseded, non-closed) run. */
  isActive: (generation: number) => boolean;
  /**
   * Logs the maintenance error so it is not swallowed silently. Called on the
   * reject path regardless of whether the generation is still active.
   */
  logError: (error: unknown) => void;
  /**
   * Generation-guarded cleanup (e.g. clearing maintenance progress / releasing
   * the task handle). Always runs after the promise settles.
   */
  onFinally: () => void;
};

/**
 * Wires a running post-boot-maintenance promise to the readiness signal so it
 * fires on both success and failure for the active generation, logging failures
 * and always running the finalizer. Returns the wrapped task promise (never
 * rejects — the failure is absorbed into the settle handling).
 */
export function attachPostBootMaintenanceSettle(
  maintenance: Promise<void>,
  generation: number,
  handlers: PostBootMaintenanceSettleHandlers
): Promise<void> {
  return maintenance
    .then(() => {
      if (handlers.isActive(generation)) {
        handlers.onSettleActive(generation);
      }
    })
    .catch((error: unknown) => {
      // Never swallow the failure silently (it would also surface as an
      // unhandled rejection). The readiness signal still resolves so the
      // throbber clears even when re-derivation could not finish.
      handlers.logError(error);
      if (handlers.isActive(generation)) {
        handlers.onSettleActive(generation);
      }
    })
    .finally(() => {
      handlers.onFinally();
    });
}

/**
 * ISS-8601: build the settle notifier for one maintenance run.
 *
 * Post-boot maintenance settling makes TWO announcements, and they are not the
 * same claim. Releasing the deferred startup work says "background work may
 * start"; `onImportComplete` says "the first-launch import FINISHED", and that
 * one flips the readiness bit the cloud-read cutover reads
 * (`RendererReadinessGates.notifyInitialCollectorImportComplete`).
 *
 * A maintenance pass re-armed after the boot-import watchdog gave up must make
 * the first announcement and NOT the second: the rebuild is owed and safe, but
 * the import demonstrably did not finish, and claiming otherwise would let a
 * cloud read report completeness over sources this machine never parsed. That is
 * the distinction `claimImportComplete` carries.
 *
 * Extracted from the runtime so both arms can be asserted directly — the runtime
 * closure cannot be instantiated in a unit test, and a structural check that the
 * flag is PASSED would not prove the call is actually suppressed.
 */
export function createMaintenanceSettleNotifier(deps: {
  claimImportComplete: boolean;
  onImportComplete?: () => void;
  onSettled: () => void;
}): () => void {
  return () => {
    if (deps.claimImportComplete) {
      deps.onImportComplete?.();
    }
    deps.onSettled();
  };
}
