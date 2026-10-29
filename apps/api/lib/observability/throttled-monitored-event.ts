import "server-only";

import { log } from "@repo/observability/log";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "./fixed-window-emission-throttle";

/**
 * @file throttled-monitored-event.ts
 * @description ISS-10815: the ONE emit-or-roll-up body every throttled monitored
 * event in `apps/api` shares.
 *
 * Two modules had reproduced it line for line — `record` the occurrence, flush a
 * closed window's suppressed count as an `aggregated` rollup, emit a first
 * occurrence — differing only in which fields they carry and which event name
 * they log, both of which are already values. The emitted shape is a contract a
 * monitor reads (`occurrences`, `aggregated`, `flushedBy`), so two copies of it
 * is two places for that contract to drift on the next change to it.
 *
 * It owns the EMISSION only. Which key a caller throttles on, and whether an
 * occurrence is worth reporting at all, stay with the caller — those are the
 * parts that genuinely differ.
 */

/**
 * One throttled occurrence's identity: the event to log, and the fields that
 * identify it on BOTH the first occurrence and the rollup. `payload` is what a
 * suppressed occurrence still shares with the one that was emitted, which is
 * why the rollup can carry it while it carries no per-occurrence context.
 */
type MonitoredEventContext = {
  event: string;
  payload: Record<string, unknown>;
};

/** What a caller gets back — see {@link createThrottledMonitoredEvent}. */
export type ThrottledMonitoredEvent = {
  /**
   * Report one occurrence. `throttleKey` is the caller's budget key; `fields` is
   * this occurrence's own context, merged UNDER `payload` so an identifying
   * field can never be shadowed by a caller's payload.
   */
  report(
    throttleKey: string,
    context: MonitoredEventContext,
    fields: Record<string, unknown>
  ): void;
  /**
   * Flush every key whose window has closed as a `flushedBy: "expiry"` rollup.
   * A caller that needs a burst followed by quiet to reach the monitor calls it
   * from a path it runs on every request (see
   * {@link FixedWindowEmissionThrottle.drainExpired}).
   */
  drainExpired(now: number): void;
  /**
   * Exposed so tests can `clear()` it between cases; production code must not
   * reach into it.
   */
  throttle: FixedWindowEmissionThrottle<MonitoredEventContext>;
};

/**
 * Build a throttled monitored-event emitter: one event per throttle key per
 * window, the rest counted and flushed as an `aggregated` rollup so a monitor
 * still sees the volume.
 */
export function createThrottledMonitoredEvent(): ThrottledMonitoredEvent {
  const emitRollup = (
    context: MonitoredEventContext,
    occurrences: number,
    flushedBy: EmissionRollupCause
  ) => {
    // The rollup for occurrences a closed window suppressed: one event carrying
    // their count, marked `aggregated` so a monitor can tell it from a first
    // occurrence. It omits the per-occurrence fields, which the suppressed
    // occurrences need not share.
    log.error(context.event, {
      ...context.payload,
      occurrences,
      aggregated: true,
      flushedBy,
    });
  };
  const throttle = new FixedWindowEmissionThrottle<MonitoredEventContext>({
    onFlush: emitRollup,
  });
  return {
    throttle,
    drainExpired(now) {
      throttle.drainExpired(now);
    },
    report(throttleKey, context, fields) {
      const decision = throttle.record(throttleKey, context, Date.now());
      if (decision.flushedSuppressedCount > 0) {
        emitRollup(
          context,
          decision.flushedSuppressedCount,
          EmissionRollupCause.Window
        );
      }
      if (decision.emit) {
        log.error(context.event, {
          ...fields,
          ...context.payload,
          occurrences: 1,
        });
      }
    },
  };
}
