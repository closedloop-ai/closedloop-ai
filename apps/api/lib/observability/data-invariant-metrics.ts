import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import type { IntegrationTokenOwnerBacklog } from "@/app/cron/audit-data-invariants/integration-token-encryption";

/** Long enough for every real model id we have seen, short enough to bound a label. */
const LABEL_MAX_CHARS = 64;
const UNSAFE_LABEL_CHARS_RE = /[^a-zA-Z0-9._:@/-]/g;
const UNKNOWN_LABEL = "unknown";

type DataInvariantSampleMetric = {
  metric: FilterToken;
  value: number;
  sampleIds: string[];
};

type DataInvariantGaugeMetric = {
  metric: FilterToken;
  value: number;
};

/**
 * ISS-8515: a gauge whose actionable detail is a bounded per-model breakdown.
 * `value` is the graphable total and is ALWAYS emitted, including 0, so the
 * Datadog monitor never reads no-data and cannot mistake "healthy" for "the cron
 * stopped running".
 */
type DataInvariantModelBreakdownMetric = {
  metric: FilterToken;
  value: number;
  models: Array<{ model: string; sessionCount: number }>;
};

/**
 * ISS-9434: a gauge whose actionable detail is which artifact type stored which
 * off-vocabulary word. `value` is the graphable total across EVERY
 * off-vocabulary group, including those the bounded breakdown could not carry,
 * and is always emitted so the monitor cannot read a stopped cron as healthy.
 */
type DataInvariantArtifactStatusBreakdownMetric = {
  metric: FilterToken;
  value: number;
  statuses: Array<{
    type: string;
    subtype: string | null;
    status: string;
    artifactCount: number;
  }>;
};

export function emitZeroCostSessions(count: number, sampleIds: string[]): void {
  emitTelemetryMetric<DataInvariantSampleMetric>({
    metric: FilterToken.DataInvariantZeroCostSessions,
    value: count,
    sampleIds,
  });
}

export function emitZeroCostBranches(count: number, sampleIds: string[]): void {
  emitTelemetryMetric<DataInvariantSampleMetric>({
    metric: FilterToken.DataInvariantZeroCostBranches,
    value: count,
    sampleIds,
  });
}

export function emitUnbranchedPrs(count: number, sampleIds: string[]): void {
  emitTelemetryMetric<DataInvariantSampleMetric>({
    metric: FilterToken.DataInvariantUnbranchedPrs,
    value: count,
    sampleIds,
  });
}

export function emitLinesFilesMismatch(
  count: number,
  sampleIds: string[]
): void {
  emitTelemetryMetric<DataInvariantSampleMetric>({
    metric: FilterToken.DataInvariantLinesFilesMismatch,
    value: count,
    sampleIds,
  });
}

export function emitZeroEstimateWithReportedCost(
  count: number,
  sampleIds: string[]
): void {
  emitTelemetryMetric<DataInvariantSampleMetric>({
    metric: FilterToken.DataInvariantZeroEstimateWithReportedCost,
    value: count,
    sampleIds,
  });
}

export function emitDualLedgerBranches(count: number): void {
  emitTelemetryMetric<DataInvariantGaugeMetric>({
    metric: FilterToken.DataInvariantDualLedgerBranches,
    value: count,
  });
}

export function emitEnrichmentPendingSessions(count: number): void {
  emitTelemetryMetric<DataInvariantGaugeMetric>({
    metric: FilterToken.DataInvariantEnrichmentPendingSessions,
    value: count,
  });
}

export function emitEnrichmentPendingPrs(count: number): void {
  emitTelemetryMetric<DataInvariantGaugeMetric>({
    metric: FilterToken.DataInvariantEnrichmentPendingPrs,
    value: count,
  });
}

export function emitCostEstimateDivergence(count: number): void {
  emitTelemetryMetric<DataInvariantGaugeMetric>({
    metric: FilterToken.DataInvariantCostEstimateDivergence,
    value: count,
  });
}

export function emitUnpricedTokenSessions(
  count: number,
  models: Array<{ model: string; sessionCount: number }>
): void {
  emitTelemetryMetric<DataInvariantModelBreakdownMetric>({
    metric: FilterToken.DataInvariantUnpricedTokenSessions,
    value: count,
    models: models.map((entry) => ({
      model: boundTelemetryLabel(entry.model),
      sessionCount: entry.sessionCount,
    })),
  });
}

export function emitOffVocabularyArtifactStatuses(
  count: number,
  statuses: Array<{
    type: string;
    subtype: string | null;
    status: string;
    artifactCount: number;
  }>
): void {
  emitTelemetryMetric<DataInvariantArtifactStatusBreakdownMetric>({
    metric: FilterToken.DataInvariantOffVocabularyArtifactStatuses,
    value: count,
    statuses: statuses.map((entry) => ({
      type: entry.type,
      subtype: entry.subtype,
      // The one caller-influenced label of the three: `type` and `subtype` are
      // Postgres enums, `status` is the freeform column this gauge audits.
      status: boundTelemetryLabel(entry.status),
      artifactCount: entry.artifactCount,
    })),
  });
}

/**
 * A producer-supplied string reaching Datadog as a label is bounded HERE, at the
 * last point the API owns it. Both gauges that carry one exist to surface a
 * value we could not interpret — a model with no price (ISS-8515), a status
 * outside its vocabulary (ISS-9434) — so an unrecognised value must stay
 * LEGIBLE: an allowlist or a hash would erase exactly what is being reported.
 * What is bounded instead is the label's shape: at most LABEL_MAX_CHARS
 * characters, drawn from a conservative identifier charset, with anything else
 * folded to `_` and an empty value reported as `unknown`.
 *
 * Label CARDINALITY is bounded separately and upstream, by the row bound each
 * breakdown applies before it emits — at most that many distinct labels per cron
 * run.
 */
function boundTelemetryLabel(value: string): string {
  const normalized = value
    .trim()
    .slice(0, LABEL_MAX_CHARS)
    .replace(UNSAFE_LABEL_CHARS_RE, "_");
  return normalized.length > 0 ? normalized : UNKNOWN_LABEL;
}

/**
 * ISS-7781: a gauge whose actionable detail is which integration owns the
 * backlog.
 */
type DataInvariantIntegrationTokenMetric = {
  metric: FilterToken;
  value: number;
  owners: IntegrationTokenOwnerBacklog[];
};

/**
 * Google and Linear rows with no access-token ciphertext, which fail every read
 * closed (ISS-11096). Always emitted, including 0, so the monitor cannot read a
 * stopped cron as a healthy table.
 */
export function emitIntegrationTokensUnencrypted(
  count: number,
  owners: IntegrationTokenOwnerBacklog[]
): void {
  emitTelemetryMetric<DataInvariantIntegrationTokenMetric>({
    metric: FilterToken.DataInvariantIntegrationTokensUnencrypted,
    value: count,
    owners,
  });
}

export function emitCrossOrgProjectAssignees(
  count: number,
  sampleIds: string[]
): void {
  emitTelemetryMetric<DataInvariantSampleMetric>({
    metric: FilterToken.DataInvariantCrossOrgProjectAssignees,
    value: count,
    sampleIds,
  });
}
