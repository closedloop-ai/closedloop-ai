/**
 * @file single-flight-runner.ts — the coalescing primitive shared by the
 * main-process coordinators that drive a read→compute→apply dance against the
 * db-host (ISS-5274).
 *
 * Extracted verbatim from `pack-scan-coordinator.ts` (FEA-3628), which had the
 * only implementation: while a run is in flight, extra triggers JOIN it and
 * schedule at most ONE trailing rerun, so back-to-back triggers never stack N
 * runs but state that changed mid-run is still picked up by the rerun.
 *
 * ISS-5274 adds a second coordinator (the catalog fetch) whose triggers are
 * boot, a 24h timer, and a user-initiated refresh IPC — three sources that can
 * otherwise overlap into concurrent GitHub fetches and racing applies. Copying
 * the mechanism would be SSOT-drift-by-copy, so it lives here once and both
 * coordinators consume it.
 *
 * `stopped` is owned here too: once `stop()` is called, `run()` resolves
 * immediately and no trailing rerun is scheduled. Callers still need their own
 * `stopped` checks BETWEEN awaits — this primitive cannot cancel work already
 * inside an `execute` call, only refuse to start new ones.
 */

export type SingleFlightRunner = {
  /** Trigger a run. Joins any in-flight run; resolves when it settles. */
  run(): Promise<void>;
  /** Refuse further runs; subsequent `run()` calls resolve immediately. */
  stop(): void;
  /** True once `stop()` has been called — for the caller's own between-await guards. */
  isStopped(): boolean;
};

export function createSingleFlightRunner(deps: {
  /** The work to coalesce. Rejections are caught and passed to `onError`. */
  execute: () => Promise<void>;
  /** Called with any error `execute` throws; must not throw. */
  onError?: (error: unknown) => void;
  /** Called when `stop()` runs, so the caller can tear down its own resources. */
  onStop?: () => void;
}): SingleFlightRunner {
  const onError = deps.onError ?? (() => {});
  let inFlight: Promise<void> | null = null;
  let rerunQueued = false;
  let stopped = false;

  const drain = (): Promise<void> => {
    return deps
      .execute()
      .catch((error: unknown) => {
        onError(error);
      })
      .finally(() => {
        inFlight = null;
        if (rerunQueued && !stopped) {
          rerunQueued = false;
          inFlight = drain();
        }
      });
  };

  return {
    run(): Promise<void> {
      if (stopped) {
        return Promise.resolve();
      }
      if (inFlight) {
        // A run is in flight; ensure exactly one more follows it so state that
        // changed mid-run is still picked up.
        rerunQueued = true;
        return inFlight;
      }
      inFlight = drain();
      return inFlight;
    },
    stop(): void {
      stopped = true;
      rerunQueued = false;
      deps.onStop?.();
    },
    isStopped(): boolean {
      return stopped;
    },
  };
}
