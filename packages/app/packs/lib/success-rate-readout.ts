/**
 * ISS-9853 — the "Success rate" tile's delta caption and population copy on the
 * Packs Performance tab.
 *
 * The tile speaks about TWO populations and, until this ticket, claimed both:
 *  - its VALUE is the share of the pack's sessions that reached a merged PR,
 *    which the server computes over the sessions it was handed — a bounded
 *    sample of the pack's cohort when the usage lane hit its row bound
 *    (`mergedPrsTruncated`);
 *  - its DELTA compares that share against a baseline of org sessions, whose
 *    comparator is a bounded most-recent sample of the window
 *    (`baselineSampleSize`), while the LOC/token deltas beside it compare
 *    against whole-window aggregates.
 *
 * Neither was disclosed: the value sat under "Share of the pack's sessions…"
 * and the delta under a bare "vs. baseline". Both claims are withdrawn here,
 * and only when the producer DECLARED the sample — an undeclared coverage state
 * is not evidence of one, so inventing a caveat there would be the same
 * overstatement pointed the other way.
 */

import {
  BaselineSampleCoverage,
  MergedPrsCoverage,
  resolveBaselineSampleCoverage,
  resolveMergedPrsCoverage,
} from "@repo/api/src/types/analytics";
import { formatNumber } from "@repo/app/shared/lib/format-utils";
import { UNDECLARED_COHORT_COVERAGE_CAVEAT } from "@repo/app/shared/lib/merged-prs-coverage-copy";
import type { PackPerformance } from "./pack-view";

/** The shipped caption, and what every undeclared state keeps. */
const WHOLE_POPULATION_DELTA_LABEL = "vs. baseline";

/** The shipped headline: a claim over every session the pack ran in. */
const WHOLE_POPULATION_HEADLINE =
  "Share of the pack's sessions that link to a merged PR.";

/** The same claim, narrowed to the sessions the server could actually read. */
const SAMPLED_COHORT_HEADLINE =
  "Share of a sample of the pack's sessions that link to a merged PR.";

/**
 * The cohort caveat. A SHARE can move either way when the uncounted sessions
 * are added, so this deliberately does not reuse `cappedCohortScanCaveat`,
 * whose closing sentence is a floor claim true only of a count.
 */
const SAMPLED_COHORT_CAVEAT =
  "This pack ran in more sessions than this share covers; we counted the ones a single bounded read returned. The real share could be higher or lower.";

type SuccessRateCoverage = Pick<
  PackPerformance,
  "baselineSampleSize" | "mergedPrsTruncated"
>;

/** The `MetricCard` info-hint shape (`what` headline, optional `how` caveat). */
export type SuccessRateInfo = { what: string; how?: string };

export type SuccessRateReadout = {
  deltaLabel: string;
  info: SuccessRateInfo;
};

/**
 * The tile's caption and population copy for the coverage the producer
 * declared. An undeclared COMPARATOR keeps the shipped caption (absence is not
 * evidence of a sample); an undeclared COHORT keeps the shipped headline but
 * withdraws the whole-population claim in the caveat, matching what the Merged
 * PRs tile already does with the very same field.
 */
export function successRateTileReadout(
  perf: SuccessRateCoverage
): SuccessRateReadout {
  const cohortCoverage = resolveMergedPrsCoverage(perf.mergedPrsTruncated);
  const sampledCohort = cohortCoverage === MergedPrsCoverage.Capped;
  const sampleSize = declaredBaselineSampleSize(perf.baselineSampleSize);
  const caveats: string[] = [];
  if (sampledCohort) {
    caveats.push(SAMPLED_COHORT_CAVEAT);
  }
  if (cohortCoverage === MergedPrsCoverage.Unknown) {
    // The share and the Merged PRs count beside it come from the SAME cohort
    // read, so a producer that declared nothing leaves both populations
    // unvouched-for. The sibling tile already withdraws its claim here; a tile
    // still asserting "the pack's sessions" would contradict it on one card.
    caveats.push(UNDECLARED_COHORT_COVERAGE_CAVEAT);
  }
  if (sampleSize !== null) {
    caveats.push(sampledBaselineCaveat(sampleSize));
  }
  return {
    deltaLabel: baselineDeltaLabel(sampleSize),
    info: {
      what: sampledCohort ? SAMPLED_COHORT_HEADLINE : WHOLE_POPULATION_HEADLINE,
      ...(caveats.length > 0 ? { how: caveats.join(" ") } : {}),
    },
  };
}

/** The comparator's sample size when the producer DECLARED one, else null. */
function declaredBaselineSampleSize(
  baselineSampleSize: number | null | undefined
): number | null {
  const declared =
    resolveBaselineSampleCoverage(baselineSampleSize) ===
    BaselineSampleCoverage.Sampled;
  return declared && typeof baselineSampleSize === "number"
    ? baselineSampleSize
    : null;
}

/**
 * "last {n}", not "{n}": the sample is the most RECENT baseline sessions, and
 * saying so implies the rest exist — the fact the bare caption hid.
 */
function baselineDeltaLabel(sampleSize: number | null): string {
  if (sampleSize === null) {
    return WHOLE_POPULATION_DELTA_LABEL;
  }
  return `vs. last ${formatNumber(sampleSize)} baseline sessions`;
}

function sampledBaselineCaveat(sampleSize: number): string {
  const count = formatNumber(sampleSize);
  return `This window holds more than ${count} sessions that did not use the pack, and we compare against the ${count} most recent of them. Against every baseline session the delta could land higher or lower.`;
}
