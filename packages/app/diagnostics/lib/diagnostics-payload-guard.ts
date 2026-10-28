import { isRecord } from "@repo/lib/harness/type-guards";
import type {
  ActivityCoverageData,
  BackfillStats,
  DiagnosticsPayload,
  DiagnosticsRepoRow,
  DiagnosticsWithheldRow,
  DiagnosticsWithheldScan,
  LinkStatsRow,
  LinkTotals,
} from "./diagnostics-payload";

/**
 * ISS-10004 AC2 — read one section's slice of a diagnostics payload, or refuse.
 *
 * `DiagnosticsPayload` is what the producer PROMISES; what arrives crossed a
 * process boundary from a build that may be older or newer. `LinksSection` reads
 * `linkTotals.totalLinks` during render, so an unchecked object takes down the
 * page a reader was sent to BECAUSE something was already broken.
 *
 * Each reader answers for its own section, so a corrupt `linkStats` costs the
 * reader Links and not the Repos table that arrived intact. `null` means
 * MALFORMED; an ABSENT optional key stays `undefined` and keeps meaning "this
 * producer cannot tell you" all the way to the section that renders it.
 *
 * Depth reaches every value the rendering code INDEXES INTO, elements included —
 * `CoverageRows` maps `axis.buckets`, so an axis without them throws exactly as a
 * missing `linkTotals` does.
 *
 * Leaf values are checked in ONE place, and the exception is deliberate
 * (davetho review): a leaf the renderer CALLS A METHOD ON is not a leaf as far
 * as crashing goes. `WithheldSection` runs `formatTokens(row.withheldTokens)`,
 * and `formatTokens` guards `null` alone — so `[{}]` cleared `isRecordArray`,
 * reached the render, and died on `undefined.toLocaleString()`, taking down the
 * whole malformed-payload path instead of refusing only Withheld. `withheldCount`
 * is the same defect quieter: absent, it turns the section's total into `NaN`
 * rather than throwing.
 *
 * That is why the row predicates below name fields while the other readers do
 * not. The general rule still holds everywhere else — a full copy of the
 * contract drifts — so this stays scoped to the rows whose own renderer reaches
 * past the container.
 */

/** Every element the rendering code indexes into must itself be indexable. */
function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

/** `CoverageRows` maps `axis.buckets` and reads `cell` off each bucket. */
function isCoverageAxisShaped(axis: unknown): boolean {
  return (
    isRecord(axis) &&
    isRecordArray(axis.buckets) &&
    axis.buckets.every((bucket) => isRecord(bucket.cell))
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * `Number.isFinite` rather than `typeof`: `NaN` and the infinities are numbers
 * that render as "NaN" and arithmetic that silently poisons a total.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** `null` is a VALUE here — the renderer prints it as an explicit unavailable. */
function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

/** Same: `null` is the "no instant" the window formatter answers for. */
function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

/** Every field `WithheldSection` reads off a row, in the row's own order. */
function isWithheldRowShaped(row: Record<string, unknown>): boolean {
  return (
    isString(row.rootRawId) &&
    isString(row.sourcePath) &&
    isFiniteNumber(row.withheldCount) &&
    isString(row.reason) &&
    isNullableFiniteNumber(row.withheldTokens) &&
    isNullableFiniteNumber(row.withheldCacheTokens) &&
    isNullableString(row.earliestChildStartedAt) &&
    isNullableString(row.latestChildEndedAt) &&
    typeof row.windowPartial === "boolean" &&
    isString(row.observedAt)
  );
}

/** The scan rows are read for both of their fields, so both are checked. */
function isWithheldScanShaped(scan: Record<string, unknown>): boolean {
  return isString(scan.sourcePath) && isString(scan.observedAt);
}

/**
 * A predicate rather than a cast at the return site: FEA-4114 bans the
 * `as unknown as T` that narrowing to `Record<string, unknown>` first would
 * otherwise force, and a guard is the remedy that rule names.
 */
function isCoverageShaped(value: unknown): value is ActivityCoverageData {
  return (
    isRecord(value) &&
    isRecord(value.overall) &&
    Array.isArray(value.axes) &&
    value.axes.every(isCoverageAxisShaped)
  );
}

/** The payload as it arrived, before any field is believed. */
function fields(payload: DiagnosticsPayload): Record<string, unknown> {
  return isRecord(payload) ? payload : {};
}

export function readReposSection(
  payload: DiagnosticsPayload
): DiagnosticsRepoRow[] | null {
  const repos = fields(payload).repos;
  return isRecordArray(repos) ? (repos as DiagnosticsRepoRow[]) : null;
}

export function readBackfillSection(
  payload: DiagnosticsPayload
): BackfillStats | null {
  const backfill = fields(payload).backfill;
  if (!isRecord(backfill)) {
    return null;
  }
  return isRecord(backfill.artifactLinks) &&
    (backfill.prBackfill === undefined || isRecord(backfill.prBackfill))
    ? (backfill as BackfillStats)
    : null;
}

export function readLinksSection(
  payload: DiagnosticsPayload
): { linkStats: LinkStatsRow[]; linkTotals: LinkTotals } | null {
  const { linkStats, linkTotals } = fields(payload);
  return isRecordArray(linkStats) && isRecord(linkTotals)
    ? {
        linkStats: linkStats as LinkStatsRow[],
        linkTotals: linkTotals as LinkTotals,
      }
    : null;
}

/**
 * Both keys are legitimately ABSENT (ISS-5266), and the section renders that
 * absence as UNKNOWN rather than as "nothing is withheld" — so `undefined`
 * survives to it untouched and only a present non-array is a refusal.
 */
export function readWithheldSection(payload: DiagnosticsPayload): {
  withheld: DiagnosticsWithheldRow[] | undefined;
  scans: DiagnosticsWithheldScan[] | undefined;
} | null {
  const { opencodeWithheld, opencodeWithheldScans } = fields(payload);
  if (
    opencodeWithheld !== undefined &&
    !(
      isRecordArray(opencodeWithheld) &&
      opencodeWithheld.every(isWithheldRowShaped)
    )
  ) {
    return null;
  }
  if (
    opencodeWithheldScans !== undefined &&
    !(
      isRecordArray(opencodeWithheldScans) &&
      opencodeWithheldScans.every(isWithheldScanShaped)
    )
  ) {
    return null;
  }
  return {
    scans: opencodeWithheldScans as DiagnosticsWithheldScan[] | undefined,
    withheld: opencodeWithheld as DiagnosticsWithheldRow[] | undefined,
  };
}

/**
 * `undefined` reaches the section as the third state it already distinguishes:
 * the read could not run, which is not a measurement of zero coverage.
 */
export function readCoverageSection(
  payload: DiagnosticsPayload
): { coverage: ActivityCoverageData | undefined } | null {
  const coverage = fields(payload).activityCoverage;
  if (coverage === undefined) {
    return { coverage: undefined };
  }
  if (!isCoverageShaped(coverage)) {
    return null;
  }
  return { coverage };
}
