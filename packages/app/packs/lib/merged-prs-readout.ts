/**
 * ISS-6462 — the "Merged PRs" tile's value and population copy on the Packs
 * Performance tab.
 *
 * The server counts distinct merged PRs over the FIRST {@link COHORT_SCAN_CAP}
 * cohort sessions (`apps/api/app/agent-components/cohort-performance.ts`), so on
 * a pack with a larger cohort the figure is a floor over an insertion-ordered
 * sample — while the tile printed it as an exact count. ISS-5521 fixed the same
 * claim on the Agents component-detail card behind the `agents-detail-honesty`
 * gate; that gate is scoped to the Agents detail strip and does not reach this
 * tile, whose undercount is what ships today.
 *
 * The trailing `+` is the page's existing partial-total convention, not a new
 * glyph: `detailTabTruncationReadout` marks a partial total the same way. A
 * leading `≥` would be the only non-numeric character in the metric grid and
 * NVDA at default punctuation level drops it outright, turning "at least 996"
 * back into "996" for exactly the reader who can least afford the difference.
 */

import {
  MergedPrsCoverage,
  resolveMergedPrsCoverage,
} from "@repo/api/src/types/analytics";
import { formatNumber, KPI_NO_VALUE } from "@repo/app/shared/lib/format-utils";
import {
  cappedCohortScanCaveat,
  UNDECLARED_COHORT_COVERAGE_CAVEAT,
} from "@repo/app/shared/lib/merged-prs-coverage-copy";
import type { PackPerformance } from "./pack-view";

/** The `MetricCard` info-hint shape (`what` headline, optional `how` caveat). */
export type MergedPrsInfo = { what: string; how?: string };

type MergedPrsCoverageInput = Pick<
  PackPerformance,
  "mergedPrs" | "mergedPrsTruncated"
>;

/**
 * The headline for every state that is NOT a declared cap — the shipped copy,
 * unchanged. One declaration, because the undeclared-coverage state and the
 * whole-cohort state make the same claim about the population and differ only in
 * whether a caveat follows it.
 */
const UNQUALIFIED_HEADLINE =
  "Distinct merged PRs produced by the pack's sessions.";

/**
 * The tile's value: the count, marked `+` when the producer DECLARED it was
 * taken over a capped sample. An undeclared coverage state is not evidence the
 * count was truncated, so inventing a floor marker there would be the same
 * overstatement pointed the other way.
 */
export function mergedPrsTileValue(perf: MergedPrsCoverageInput): string {
  if (!isCountKnown(perf.mergedPrs)) {
    return KPI_NO_VALUE;
  }
  const formatted = formatNumber(perf.mergedPrs);
  return isCappedCount(perf) ? `${formatted}+` : formatted;
}

/**
 * The tile's population copy, in the states the payload can actually express.
 * A count we could not compute at all keeps the unchanged baseline copy: there
 * is no number for a coverage claim to qualify.
 */
export function mergedPrsTileInfo(perf: MergedPrsCoverageInput): MergedPrsInfo {
  if (isCappedCount(perf)) {
    return {
      what: "At least this many distinct merged PRs produced by the pack's sessions.",
      how: cappedCohortScanCaveat("pack"),
    };
  }
  if (
    isCountKnown(perf.mergedPrs) &&
    resolveMergedPrsCoverage(perf.mergedPrsTruncated) ===
      MergedPrsCoverage.Unknown
  ) {
    return {
      what: UNQUALIFIED_HEADLINE,
      how: UNDECLARED_COHORT_COVERAGE_CAVEAT,
    };
  }
  return { what: UNQUALIFIED_HEADLINE };
}

/**
 * `Number.isFinite` rather than a null check: this is wire data, so a
 * version-skewed producer can OMIT the field entirely, and `formatNumber`
 * renders `undefined` as the literal "NaN".
 */
function isCountKnown(mergedPrs: number | null): mergedPrs is number {
  return typeof mergedPrs === "number" && Number.isFinite(mergedPrs);
}

function isCappedCount(perf: MergedPrsCoverageInput): boolean {
  return (
    isCountKnown(perf.mergedPrs) &&
    resolveMergedPrsCoverage(perf.mergedPrsTruncated) ===
      MergedPrsCoverage.Capped
  );
}
