import "server-only";

import { createThrottledMonitoredEvent } from "@/lib/observability/throttled-monitored-event";

/**
 * The monitored events the component detail raises when one of its rowless
 * usage aggregates fails. Each event is its own throttle reason.
 */
export const DetailUsageAggregateFailedEvent = {
  SeenBounds: "agent_components_detail_seen_bounds_aggregate_failed",
  Totals: "agent_components_detail_usage_totals_aggregate_failed",
} as const;
export type DetailUsageAggregateFailedEvent =
  (typeof DetailUsageAggregateFailedEvent)[keyof typeof DetailUsageAggregateFailedEvent];

/**
 * whitlockk (#7051 review), `apps/api/AGENTS.md` "Emission and Abuse Control": any
 * org member can refresh a component detail, and on a pathological org every
 * refresh times out the same aggregate. One event per (org, event) per window;
 * the rest are counted and flushed as a rollup, so the monitor still sees the
 * volume. The key parts are an org id and a closed event name, so the keyspace
 * is at most two keys per org, under the helper's LRU cap.
 */
const aggregateFailureEvent = createThrottledMonitoredEvent();

/**
 * Exported so tests can `clear()` it between cases; production code must not
 * reach into it.
 */
export const detailUsageAggregateFailureThrottle =
  aggregateFailureEvent.throttle;

/**
 * Report one failed detail usage aggregate on its monitored error lane, bound
 * per (org, event). `fields` is the failing site's own context: the error
 * message, the kind, and its statement or lane count.
 */
export function reportDetailUsageAggregateFailure(
  event: DetailUsageAggregateFailedEvent,
  organizationId: string,
  fields: Record<string, unknown>
): void {
  aggregateFailureEvent.report(
    `${organizationId}|${event}`,
    { event, payload: { organizationId } },
    fields
  );
}
