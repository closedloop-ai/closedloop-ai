import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";

// `value:` (gauge), not `count:`: each sample is the current platform total, so
// summing samples across a window would multiply it (packages/observability
// README, "Metric field semantics").
type SessionFleetTotalSessionsMetric = {
  metric: typeof FilterToken.SessionFleetTotalSessions;
  value: number;
};

type SessionFleetTotalOrgsMetric = {
  metric: typeof FilterToken.SessionFleetTotalOrgs;
  value: number;
};

/** Sessions across every active org (ISS-12050). */
export function emitSessionFleetTotalSessions(totalSessions: number): void {
  emitTelemetryMetric<SessionFleetTotalSessionsMetric>({
    metric: FilterToken.SessionFleetTotalSessions,
    value: totalSessions,
  });
}

/**
 * Active organizations, including ones with no sessions — the denominator of
 * the dashboard's sessions-per-org average (operator rulings, ISS-12050).
 */
export function emitSessionFleetTotalOrgs(totalOrgs: number): void {
  emitTelemetryMetric<SessionFleetTotalOrgsMetric>({
    metric: FilterToken.SessionFleetTotalOrgs,
    value: totalOrgs,
  });
}
