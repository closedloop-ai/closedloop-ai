import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";

// ---------------------------------------------------------------------------
// session.ingestion.* metric emitter module (ISS-4543)
//
// Single import point for cloud session-ingestion health observability. One
// payload `type` per metric so the shape is enforced at compile time, and one
// thin wrapper each delegating to `emitTelemetryMetric` so the
// `_telemetryMetric: true` marker contract lives in exactly one place.
//
// WHY THIS FAMILY EXISTS. ISS-4537 froze cloud session ingestion for an entire
// org for ~2 days and was found only by manual inspection, and nothing measured
// "is session data still arriving?". These metrics make that class of stall
// observable: staleness / stalled_orgs / active_orgs, sampled by the
// `/cron/sample-session-ingestion-health` cron, catch any ingestion stall — a
// broken ingest route, a dead desktop fleet, a wedged sync queue — at the cost
// of taking the stall threshold to fire.
//
// ISS-11449 removed `policy_denied` and `org_lookup_miss`. Both observed exactly
// one thing, the org session-sync policy that caused ISS-4537, and that gate no
// longer exists: a user's own `DataSyncLevel` election is the only control, and
// it is decided on the device before anything is sent, so there is no
// server-side denial left to count.
//
// Emitting these does NOT create a queryable Datadog metric on its own: each
// needs a paired `datadog_logs_metric` generator plus a `datadog_monitor` in
// `example-org/infrastructure` (PRD-159). See packages/observability/README.md.
// ---------------------------------------------------------------------------

type SessionIngestionStalenessMetric = {
  metric: typeof FilterToken.SessionIngestionStaleness;
  orgId: string;
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

  quietOrgCount: number;
};

export function emitSessionIngestionStaleness(
  orgId: string,
  stalenessMs: number
): void {
  emitTelemetryMetric<SessionIngestionStalenessMetric>({
    metric: FilterToken.SessionIngestionStaleness,
    orgId,
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
