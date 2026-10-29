/**
 * @file harness-result-retention-sweep.ts
 * @description ISS-7332 — the boot-owned cleanup path for retained raw harness
 * result envelopes.
 *
 * The store applies its 90-day window opportunistically: on construction, and
 * again whenever another envelope is retained. Both are driven by a loop
 * finishing, so a user who stops running eligible loops — finished the project,
 * switched machines, went on leave — keeps every retained envelope on disk
 * indefinitely past the window it was promised. Those lines are PLAINTEXT and
 * carry the run's final assistant text, so that is a privacy commitment being
 * silently broken, not a housekeeping miss.
 *
 * This sweep makes expiry owned by app lifetime instead: one prune at boot, then
 * one a day for as long as the app runs. It touches only the window and the caps
 * the store already enforces — there is no second retention policy here.
 */

import { gatewayLog } from "../logging/gateway-logger.js";
import {
  getSharedHarnessResultEnvelopeStore,
  type HarnessResultEnvelopeStore,
} from "./harness-result-retention.js";

/** Once a day: the window is measured in days, so a finer interval buys nothing. */
const DEFAULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TAG = "harness-result-retention";

export type HarnessResultRetentionSweepOptions = {
  /** Defaults to the process-wide store. */
  store?: HarnessResultEnvelopeStore;
  /** Defaults to 24h. */
  intervalMs?: number;
  log?: (message: string) => void;
};

/** A running sweep. {@link stop} is idempotent and must run on app teardown. */
export type HarnessResultRetentionSweep = {
  /** Prune now, outside the schedule. Returns how many envelopes expired. */
  sweepOnce: () => number;
  stop: () => void;
};

/**
 * Prune expired envelopes now, then once per interval.
 *
 * Fail-closed: a prune that throws is logged and the schedule survives, because
 * a store that cannot be read on one tick may well be readable on the next, and
 * a dead sweep is the condition this module exists to prevent.
 *
 * The interval is `unref`'d so it never holds the process open, and {@link
 * HarnessResultRetentionSweep.stop} clears it — a superseded or stopped sweep
 * must not keep a timer alive, and calling `stop` twice is a no-op.
 */
export function startHarnessResultRetentionSweep(
  options: HarnessResultRetentionSweepOptions = {}
): HarnessResultRetentionSweep {
  const log =
    options.log ?? ((message: string) => gatewayLog.info(TAG, message));
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;

  function sweepOnce(): number {
    const store = options.store ?? getSharedHarnessResultEnvelopeStore();
    const dropped = store.pruneExpired();
    if (dropped > 0) {
      log(`retention sweep dropped ${dropped} expired envelope(s)`);
    }
    return dropped;
  }

  function guardedSweep(): void {
    try {
      sweepOnce();
    } catch (error) {
      log(
        `retention sweep failed: ${error instanceof Error ? error.name : "non-error throw"}`
      );
    }
  }

  guardedSweep();
  let timer: ReturnType<typeof setInterval> | null = setInterval(
    guardedSweep,
    intervalMs
  );
  timer.unref?.();

  return {
    sweepOnce,
    stop(): void {
      if (timer === null) {
        return;
      }
      clearInterval(timer);
      timer = null;
    },
  };
}
