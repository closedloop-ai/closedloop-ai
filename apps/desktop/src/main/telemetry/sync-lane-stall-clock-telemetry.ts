/**
 * @file sync-lane-stall-clock-telemetry.ts
 * @description ISS-7730 — report that a persisted `lane_stalled_since` could not
 * be trusted, so the only bound a lane-wide `ingestion_failed` has was rebuilt
 * from a value the store should never have held.
 *
 * ## Why a raw log is not enough
 *
 * The column is the ONLY terminal path for the one ack class that may not spend
 * a retry budget (`agent-session-sync-lane-stall-fold.ts`). Both invalid shapes
 * are silent by construction: nothing throws, the row keeps deferring on its
 * five-minute window, and the lane reports healthy retries forever. An
 * unreadable stamp restarts the 24-hour clock on every relaunch; a stamp AHEAD
 * of the local clock keeps elapsed time negative, so the ceiling is never
 * crossed at all. Either way a session that should escalate never does, and
 * `gatewayLog` would only tell whoever is already sitting at that machine — the
 * same argument `collector-records-dropped-telemetry.ts` makes.
 *
 * ## Cadence
 *
 * NOT A RATE. Both conditions are a STATE — a store holding a corrupt column, or
 * a machine whose clock stepped — so this latches to at most ONE event per
 * anomaly kind per process, exactly like `sync-freshness-lag-telemetry.ts`. Read
 * it as "this install has an untrustworthy stall clock for this reason", and
 * alert on PRESENCE.
 *
 * Content-free by construction: a closed anomaly value picks one of two fixed
 * sentences. No session id, timestamp, or offending value is interpolated —
 * those stay in the desktop-local log, where an operator can open the store.
 */

import { LaneStallClockAnomaly } from "../agent-sync/session-outbox-engine-state.js";
import { Observability } from "./observability.js";
import { canDeliverTelemetry } from "./telemetry-delivery-readiness.js";
import type { TelemetryTraceContext } from "./telemetry-protocol.js";

const ANOMALY_MESSAGE: Record<LaneStallClockAnomaly, string> = {
  [LaneStallClockAnomaly.Unreadable]:
    "A pending agent-session outbox row carried an unreadable lane_stalled_since, so its lane-wide stall clock restarted on resume and the 24h abandonment bound is not being served. Suspect a corrupt local outbox row.",
  [LaneStallClockAnomaly.Future]:
    "A pending agent-session outbox row carried a lane_stalled_since ahead of the local clock that read it, so its lane-wide stall clock was clamped to now. Suspect a backward clock step.",
};

/**
 * Anomaly kinds already reported by this process. Bounded by construction — the
 * key space is the two-member closed enum, so it cannot grow with input.
 */
const REPORTED_ANOMALIES = new Set<LaneStallClockAnomaly>();

/**
 * Report one untrustworthy persisted stall clock, once per anomaly kind per
 * process.
 *
 * Latches on ACCEPTANCE, not on the attempt: the lane drops silently when its
 * send gate is closed, so latching before the emit would let an anomaly raised
 * during a disconnect burn the only report this process will ever make, and the
 * resulting silence reads as "the stall clock here is sound".
 */
export function reportLaneStallClockAnomaly(
  anomaly: LaneStallClockAnomaly
): void {
  if (REPORTED_ANOMALIES.has(anomaly)) {
    return;
  }
  const trace: TelemetryTraceContext = {};
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: "sync.lane_stall_clock.invalid",
    message: ANOMALY_MESSAGE[anomaly],
    trace,
  });
  if (canDeliverTelemetry()) {
    REPORTED_ANOMALIES.add(anomaly);
  }
}
