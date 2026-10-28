import "server-only";

import { createThrottledMonitoredEvent } from "@/lib/observability/throttled-monitored-event";

/**
 * ISS-10815: the monitored event raised when a component detail route's content
 * fingerprint resolves to MORE THAN ONE name-level family through its usage
 * rows.
 *
 * It is raised instead of picking an arm. A fingerprint that names two families
 * cannot say which one the link meant, and answering with either would be the
 * exact defect this route is being fixed for — a confident page describing a
 * different component than the row that linked to it. The read falls through to
 * the used-only path, which describes only what the fingerprint itself proves.
 */
export const DETAIL_IDENTITY_AMBIGUOUS_USAGE_FINGERPRINT_EVENT =
  "agent_components_detail_identity_ambiguous_usage_fingerprint";

/**
 * Any org member can refresh a detail page, so one pathological fingerprint
 * would otherwise emit per request. Same posture as
 * `detail-usage-failure-telemetry.ts`: one event per (org, kind) per window, the
 * rest counted and flushed as a rollup so the monitor still sees volume. The
 * key parts are an org id and a fixed kind, so the keyspace is bounded per org.
 */
const ambiguityEvent = createThrottledMonitoredEvent();

/**
 * Exposed so tests can `clear()` it between cases; production code must not
 * reach into it.
 */
export const detailIdentityAmbiguityThrottle = ambiguityEvent.throttle;

/**
 * Count one ambiguous usage-fingerprint resolution. Called ONLY from the branch
 * where the ambiguity actually DECIDED the read — a route whose own
 * name-qualified id resolved the page anyway was not harmed by it, and an
 * error-level event on a correct render is the noise that gets a monitor
 * ignored.
 */
export function reportAmbiguousUsageFingerprint(
  organizationId: string,
  kind: string,
  fields: {
    fingerprint: string;
    /**
     * The WHOLE number of distinct name families this fingerprint reaches,
     * counted by an unbounded aggregate. Never a floor: a bounded probe would
     * understate exactly the case this event exists to report.
     */
    matchedKeyCount: number;
  }
): void {
  ambiguityEvent.report(
    `${organizationId}|${kind}`,
    {
      event: DETAIL_IDENTITY_AMBIGUOUS_USAGE_FINGERPRINT_EVENT,
      payload: { organizationId, kind },
    },
    fields
  );
}
