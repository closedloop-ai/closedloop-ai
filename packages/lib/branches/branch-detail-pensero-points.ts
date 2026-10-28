import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { locPerDollarFromLines } from "@repo/api/src/utils/loc-per-dollar";

/**
 * ISS-9814: this branch's measured Pensero delivery points, or absent when no
 * Pensero numerator is available for it at all — outside the rollout, nothing
 * backfilled, or no row that resolved to this branch. Absent is what makes the
 * card keep rendering LOC/$ (AC2); it is NOT a zero.
 *
 * `points` of `0` IS a zero, and a measured one: a branch whose interactions
 * Pensero scored at nothing has a real `0 pts/$` and must never be routed to
 * the unavailable path (AC3).
 *
 * The three shortfall flags select WHICH sentence the disclosure prints, never
 * whether the number publishes. They are independent and name different
 * causes: `hasFailedAcquisitionDay` is a day the collector attempted and never
 * once retrieved (`PenseroBackfillDay.lastSuccessAt IS NULL`), so the shortfall
 * is in ACQUISITION; `hasAmbiguousPoints` is points these collected rows hold
 * that no single branch could claim; `hasUnreadablePointValues` is a collected
 * share whose stored value no measurement could have produced (ISS-10608).
 */
export type BranchPenseroPointsInput = {
  points: number;
  hasFailedAcquisitionDay: boolean;
  hasAmbiguousPoints: boolean;
  hasUnreadablePointValues: boolean;
};

/**
 * ISS-9814: the Pensero points companion to the branch-detail LOC/$ ratio.
 *
 * Takes the SAME denominator argument the LOC ratio is given — the branch's
 * canonical attributed lifetime cost — so the two ratios describe the same
 * population and only the numerator differs (AC4). It divides through
 * `locPerDollarFromLines`, an ISS-9732 owner export, never inline.
 *
 * ## Always Partial, never withheld on coverage — ISS-9930, operator ruling
 * ## 2026-09-17
 *
 * Acquisition cannot prove completeness: `SegmentCompleteness`
 * (`packages/pensero/delivery-client.ts`) has no `Complete` member because the
 * delivery endpoint returns no hasMore/cursor/total, so a truncated window is
 * byte-identical to a quiet one. A published `Complete` would therefore be a
 * claim nothing can back, and the previous coverage REFUSAL withheld a number
 * whose operands were both present.
 *
 * Returns `undefined`, not a result, when there is no Pensero numerator for this
 * branch. That is the state the card reads as "keep rendering LOC/$" (AC2), and
 * it is deliberately a THIRD thing rather than an `unavailable()`: an absent
 * numerator means this reader has no Pensero metric at all, while an
 * `unavailable()` means the Pensero metric exists and could not be computed.
 * Collapsing them would make an org outside the rollout look like an org whose
 * delivery data is broken.
 *
 * Extracted from `branch-detail-outcomes.ts` rather than added to it: that file
 * was already past the 500-line smell, and this directory already splits by
 * concern (`branch-publication-loc.ts`, `branch-detail-cost-reconciliation.ts`).
 */
export function calculateDetailPenseroPointsPerDollar(
  numerator: BranchPenseroPointsInput | null | undefined,
  totalCost: BranchMetricResult<number>
): BranchMetricResult<number> | undefined {
  if (!numerator) {
    return undefined;
  }
  // A negative or non-finite point total is not a measurement. It is refused
  // rather than clamped, because clamping would publish a fabricated `0 pts/$`
  // for a corrupt feed — indistinguishable from the genuine zero below.
  if (!(Number.isFinite(numerator.points) && numerator.points >= 0)) {
    return unavailable();
  }
  if (totalCost.state === BranchMetricAvailability.NotApplicable) {
    return notApplicable();
  }
  if (totalCost.state === BranchMetricAvailability.NoData) {
    return noData();
  }
  if (totalCost.value === null) {
    return unavailable();
  }
  if (
    totalCost.state === BranchMetricAvailability.Partial &&
    totalCost.value === 0
  ) {
    return unavailable();
  }
  if (totalCost.value <= 0) {
    return notApplicable();
  }
  const value = locPerDollarFromLines(numerator.points, totalCost.value);
  // A genuine `0` numerator over a positive denominator survives this: the owner
  // publishes `0`, and `0 !== null`, so a measured zero reaches the card as a
  // real value instead of the unavailable path (AC3).
  return value === null ? unavailable() : partial(value, numerator);
}

function partial(
  value: number,
  numerator: BranchPenseroPointsInput
): BranchMetricResult<number> {
  return {
    state: BranchMetricAvailability.Partial,
    value,
    disclosure: penseroDisclosure(numerator),
  };
}

/**
 * Which shortfalls the reader is told about — ISS-9930 and ISS-10608, operator
 * rulings 2026-09-17.
 *
 * The flags hold independently and one result carries one disclosure, so every
 * combination has its own sentence rather than letting a cause be dropped. The
 * resting clause closes every sentence because unswept history always remains.
 */
function penseroDisclosure(
  numerator: BranchPenseroPointsInput
): BranchMetricDisclosure {
  return PENSERO_DISCLOSURE_BY_SHORTFALL[
    `${numerator.hasFailedAcquisitionDay}:${numerator.hasAmbiguousPoints}:${numerator.hasUnreadablePointValues}`
  ];
}

function unavailable(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Unavailable, value: null };
}

function notApplicable(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.NotApplicable, value: null };
}

function noData(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.NoData, value: null };
}

/** Keyed `days:ambiguous:values`; the template type makes all eight required. */
const PENSERO_DISCLOSURE_BY_SHORTFALL: Record<
  `${boolean}:${boolean}:${boolean}`,
  BranchMetricDisclosure
> = {
  "false:false:false": BranchMetricDisclosure.PenseroAcquisitionIncomplete,
  "true:false:false": BranchMetricDisclosure.PenseroAcquisitionDaysFailed,
  "false:true:false": BranchMetricDisclosure.PenseroAttributionAmbiguous,
  "false:false:true": BranchMetricDisclosure.PenseroPointValuesUnreadable,
  "true:true:false":
    BranchMetricDisclosure.PenseroDaysFailedAndAttributionAmbiguous,
  "true:false:true":
    BranchMetricDisclosure.PenseroDaysFailedAndPointValuesUnreadable,
  "false:true:true":
    BranchMetricDisclosure.PenseroAttributionAmbiguousAndPointValuesUnreadable,
  "true:true:true":
    BranchMetricDisclosure.PenseroDaysFailedAttributionAmbiguousAndPointValuesUnreadable,
};
