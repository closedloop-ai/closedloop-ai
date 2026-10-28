import { FreshestSessionLagAnomaly } from "../agent-sync/agent-session-freshness-lag.js";
import { Observability } from "./observability.js";
import { canDeliverTelemetry } from "./telemetry-delivery-readiness.js";
import type { TelemetryTraceContext } from "./telemetry-protocol.js";

const ANOMALY_MESSAGE: Record<FreshestSessionLagAnomaly, string> = {
  [FreshestSessionLagAnomaly.UnreadableUpdatedAt]:
    "A confirmed agent-session sync batch carried no readable session updated_at, so desktop→cloud freshness is unmeasurable for it. Suspect a corrupt local session row.",
  [FreshestSessionLagAnomaly.FutureUpdatedAt]:
    "A confirmed agent-session sync batch carried a session updated_at ahead of the local clock that acked it, so desktop→cloud freshness is unmeasurable for it. Suspect a backward clock step.",
};

/**
 * Anomaly kinds already reported by this process.
 *
 * Bounded by construction — the key space is the two-member closed enum, so this
 * cannot grow with input. It exists because the CALLER emits once per confirmed
 * batch, and both conditions are a STATE rather than an event: a store whose rows
 * carry no readable `updatedAt`, or a machine whose clock stepped backwards, holds
 * for as long as nobody fixes it, so an un-latched report would put an
 * `error`-severity event on the authenticated lane for every batch that install
 * ever syncs. The first report per kind is the one an operator acts on; the
 * repetition adds cost and no information. Mirrors `Observability`'s own
 * `pricingMissSeen` latch.
 *
 * Written only once the lane ACCEPTED the report — see the gate in
 * {@link reportFreshestSessionLagAnomaly}. A kind whose report was dropped is
 * deliberately left unlatched, so the set means "an operator has been told",
 * not "we tried to tell one".
 */
const REPORTED_ANOMALIES = new Set<FreshestSessionLagAnomaly>();

/**
 * Report one unmeasurable batch, once per anomaly kind per process.
 *
 * Deliberately NOT a per-batch count: see {@link REPORTED_ANOMALIES}. A reader of
 * this category must therefore treat it as "this install cannot measure freshness
 * for this reason", never as a rate.
 */
export function reportFreshestSessionLagAnomaly(
  anomaly: FreshestSessionLagAnomaly
): void {
  if (REPORTED_ANOMALIES.has(anomaly)) {
    return;
  }
  const trace: TelemetryTraceContext = {};
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: "sync.freshest_session_lag.unmeasurable",
    message: ANOMALY_MESSAGE[anomaly],
    trace,
  });
  // Latch on ACCEPTANCE, not on the attempt. The lane drops silently when its
  // send gate is closed, so latching before the emit let the first anomaly
  // raised during a disconnect burn the only report this process will ever
  // make — and the resulting silence reads as "freshness is measurable here",
  // the exact false-negative this category exists to prevent. Leaving the latch
  // clear costs at most one repeat emit per kind per outage.
  if (canDeliverTelemetry()) {
    REPORTED_ANOMALIES.add(anomaly);
  }
}
