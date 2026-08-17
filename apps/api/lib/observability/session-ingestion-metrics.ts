import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";

// ---------------------------------------------------------------------------
// session.ingestion.* metric emitter module (ISS-4543)
//
// Single import point for cloud session-ingestion health observability.
// Follows the emitHeartbeatLag / emitZombieDetector pattern from
// apps/api/lib/observability/loop-runner-metrics.ts: one payload `type` per
// metric so the shape is enforced at compile time, and one thin wrapper each
// delegating to `emitTelemetryMetric` so the `_telemetryMetric: true` marker
// contract lives in exactly one place.
//
// WHY THIS FAMILY EXISTS. ISS-4537 froze cloud session ingestion for an entire
// org for ~2 days and was found only by manual inspection: FEA-4169's
// fail-closed `Organization.sessionSyncPolicyEnabled` gate denied every ingest
// attempt, silently, and nothing measured "is session data still arriving?".
// These metrics make that class of stall observable:
//
//   • policy_denied — the FAST detector, and the one that would have caught
//     ISS-4537 in minutes. Emitted at the single org-policy choke point in
//     front of all three ingest boundaries, so a desktop fleet actively trying
//     to sync into a denied org produces a continuous signal instead of
//     silence. A stall caused by the gate is visible on the first denied
//     request, not N hours later.
//   • staleness / stalled_orgs / active_orgs — the BACKSTOP, sampled by the
//     `/cron/sample-session-ingestion-health` cron. These catch any ingestion
//     stall, including ones the gate has nothing to do with (broken ingest
//     route, dead desktop fleet, sync queue wedged), at the cost of taking the
//     stall threshold to fire.
//
// Emitting these does NOT create a queryable Datadog metric on its own: each
// needs a paired `datadog_logs_metric` generator plus a `datadog_monitor` in
// `closedloop-ai/cl-tofu-aws-live` (PRD-159). See packages/observability/README.md.
// ---------------------------------------------------------------------------

/**
 * Why an ingest attempt was denied by the org session-sync policy. Wire-level
 * snake_case values are consumed verbatim by the telemetry pipeline; do not
 * rename them without coordinating the change in `cl-tofu-aws-live`.
 *
 * The split matters operationally: `policy_disabled` is a CONFIGURATION state
 * an org admin can fix from Settings → Organization, while `org_not_found`
 * means the caller authenticated against an org row that no longer resolves —
 * a different, harder failure. Collapsing them would make the ISS-4537 signal
 * indistinguishable from ordinary deleted-org noise.
 */
export const SessionIngestionDenialReason = {
  PolicyDisabled: "policy_disabled",
  OrgNotFound: "org_not_found",
} as const;
export type SessionIngestionDenialReason =
  (typeof SessionIngestionDenialReason)[keyof typeof SessionIngestionDenialReason];

// `count` is an ADDITIVE counter: a monitor pages on `sum(count)` over a short
// window. The first denial in a throttle window (ISS-4707) emits `count: 1`; a
// suppressed burst is later flushed as a single event whose `count` is the
// total suppressed, so the sum still reflects the true denial volume. The count
// is therefore `number`, not the literal `1`.
type SessionIngestionPolicyDeniedMetric = {
  metric: typeof FilterToken.SessionIngestionPolicyDenied;
  orgId: string;
  reason: SessionIngestionDenialReason;
  count: number;
};

type SessionIngestionStalenessMetric = {
  metric: typeof FilterToken.SessionIngestionStaleness;
  orgId: string;
  policyEnabled: boolean;
  value: number;
};

// `value:` (gauge), NOT `count:` (additive counter). Both are org populations
// sampled fresh every run — "this is the current state", not "this many things
// happened". packages/observability/README.md is explicit that the field choice
// drives the downstream aggregation: a gauge emitted under `count:` gets summed
// across the window, so four samples of "1 stalled org" would page as 4.
type SessionIngestionStalledOrgsMetric = {
  metric: typeof FilterToken.SessionIngestionStalledOrgs;
  value: number;
  thresholdHours: number;
};

type SessionIngestionActiveOrgsMetric = {
  metric: typeof FilterToken.SessionIngestionActiveOrgs;
  value: number;
  windowHours: number;
  /**
   * ISS-4829: how many orgs are QUIET (past the freshness window with no ingest
   * attempt) in the same sample. Additive plain FIELD, not a metric tag — it
   * needs no `datadog_logs_metric`/monitor change in `cl-tofu-aws-live` to be
   * emitted, and it gives an operator reading a zero-active alert the population
   * that explains it without re-deriving it from `stalled_orgs`.
   */
  quietOrgCount: number;
};

/**
 * One ingest attempt refused by the org session-sync policy. Counter — alarm on
 * a non-zero sum over a short window to page on a fail-closed org within
 * minutes of its desktops first trying to sync.
 */
export function emitSessionIngestionPolicyDenied(
  orgId: string,
  reason: SessionIngestionDenialReason
): void {
  emitTelemetryMetric<SessionIngestionPolicyDeniedMetric>({
    metric: FilterToken.SessionIngestionPolicyDenied,
    orgId,
    reason,
    count: 1,
  });
}

/**
 * ISS-4707: the aggregate rollup for a throttled burst. When a per-(org,reason)
 * throttle window closes, the denials it suppressed are flushed here as ONE
 * event carrying their total, so `sum(count)` stays faithful to the real denial
 * volume while the process-local emit rate stays bounded. `suppressedCount` is
 * the number of denials suppressed after the first (which already emitted its
 * own `count: 1`); callers must only invoke this with a positive count.
 */
export function emitSessionIngestionPolicyDeniedAggregate(
  orgId: string,
  reason: SessionIngestionDenialReason,
  suppressedCount: number
): void {
  emitTelemetryMetric<SessionIngestionPolicyDeniedMetric>({
    metric: FilterToken.SessionIngestionPolicyDenied,
    orgId,
    reason,
    count: suppressedCount,
  });
}

/**
 * Milliseconds since this org last ingested any session data. Gauge — emitted
 * only for orgs that have ingested at least once, because an org with no
 * ingest history has no baseline to be stale against.
 *
 * ISS-4830 — WHO IS IN THIS EMISSION. Only ACTIVE and STALLED orgs. The payload
 * carries no classification (adding one as a metric LABEL requires a paired
 * `datadog_logs_metric` + monitor change in `closedloop-ai/cl-tofu-aws-live`,
 * PRD-159, which cannot be made from this repo), so a quiet org and a stalled
 * org emitted an identical shape and an operator drilling into a `stalled_orgs`
 * page could not tell them apart. The caller narrows the population instead: an
 * org named here is one the page is about. Quiet and dormant orgs stay visible
 * through `SessionIngestionHealthSummary` and the cron's log line.
 */
export function emitSessionIngestionStaleness(
  orgId: string,
  stalenessMs: number,
  policyEnabled: boolean
): void {
  emitTelemetryMetric<SessionIngestionStalenessMetric>({
    metric: FilterToken.SessionIngestionStaleness,
    orgId,
    policyEnabled,
    value: stalenessMs,
  });
}

/**
 * How many previously-ingesting orgs have gone silent past the stall
 * threshold. Gauge — this is the primary "ingestion is frozen somewhere" page.
 */
export function emitSessionIngestionStalledOrgs(
  stalledOrgCount: number,
  thresholdHours: number
): void {
  emitTelemetryMetric<SessionIngestionStalledOrgsMetric>({
    metric: FilterToken.SessionIngestionStalledOrgs,
    value: stalledOrgCount,
    thresholdHours,
  });
}

/**
 * How many orgs ingested session data inside the freshness window. Gauge — a
 * platform-wide `0` is the "nothing is ingesting anywhere" page, which no
 * per-org signal can express.
 *
 * ISS-4829: the caller WITHHOLDS this emission for a run in which the whole
 * platform is quiet — no org active, none stalled, at least one quiet, and the
 * fleet still checking in. A `0` there is a weekend/overnight lull, and pushing
 * it would page on ordinary inactivity exactly the way `stalled_orgs` did before
 * ISS-4678. `quietOrgCount` rides along on the runs that DO emit so the quiet
 * population is legible from the alert itself.
 */
export function emitSessionIngestionActiveOrgs(
  activeOrgCount: number,
  windowHours: number,
  quietOrgCount: number
): void {
  emitTelemetryMetric<SessionIngestionActiveOrgsMetric>({
    metric: FilterToken.SessionIngestionActiveOrgs,
    value: activeOrgCount,
    windowHours,
    quietOrgCount,
  });
}
