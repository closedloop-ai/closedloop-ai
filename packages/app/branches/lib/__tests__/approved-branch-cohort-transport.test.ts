import {
  branchAnalyticsCohortConsumerResponseSchema,
  branchAnalyticsCohortRequestSchema,
  branchAnalyticsCohortResponseSchema,
} from "@repo/api/src/types/branch-analytics-cohort";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  DateRange,
  getStableUtcDateWindowForRange,
} from "../../../shared/lib/format-utils";
import { buildApprovedBranchCohortRequest } from "../approved-branch-cohort";
import { DEFAULT_BRANCH_FILTERS } from "../branch-row";
import { wireRow } from "./approved-branch-fixtures";

const NOW = new Date("2026-07-15T12:34:56.789Z");
const OWNER_FACET = { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] };

/**
 * The exact-cohort transport, exercised at every window the List can select.
 *
 * ISS-12660 (tamsinb review on #8938): the picker, the window helper and the
 * period classifier all learned 60d while this transport did not, so the first
 * facet applied on a 60d List sent a window the request schema refuses and a
 * comparison label the response schema refuses. The builder's own output was
 * already correct, which is why these cases assert against the REAL window
 * helper and the REAL schemas rather than a literal window and the bundle type.
 */
describe("exact Branch cohort transport", () => {
  it.each([
    DateRange.Last7Days,
    DateRange.Last30Days,
    DateRange.Last60Days,
    DateRange.Last90Days,
  ])("accepts the facet-narrowed %s List window", (range) => {
    const selected = wireRow({ id: "branch-b" });
    const { startDate, endDate } = getStableUtcDateWindowForRange(range, NOW);

    const request = buildApprovedBranchCohortRequest({
      filteredRows: [selected],
      unfilteredRows: [wireRow({ id: "branch-a" }), selected],
      filters: OWNER_FACET,
      dateRange: range,
      startDate,
      endDate,
    });

    expect(request).toEqual({ branchIds: ["branch-b"], startDate, endDate });
    expect(branchAnalyticsCohortRequestSchema.parse(request)).toEqual(request);
  });

  it("round-trips a 60-day cohort answer through both response parsers", () => {
    const { startDate, endDate } = getStableUtcDateWindowForRange(
      DateRange.Last60Days,
      NOW
    );
    const response = {
      matchedBranchIds: ["branch-b"],
      canonicalMetrics: sixtyDayCohortMetrics(startDate, endDate),
    };

    expect(branchAnalyticsCohortResponseSchema.parse(response)).toEqual(
      response
    );
    expect(branchAnalyticsCohortConsumerResponseSchema.parse(response)).toEqual(
      response
    );
  });
});

function sixtyDayCohortMetrics(
  startDate: string | undefined,
  endDate: string | undefined
): BranchListMetricBundle {
  const metric = {
    current: { state: BranchMetricAvailability.Complete, value: 1 } as const,
    comparison: {
      label: BranchMetricComparisonLabel.PriorSixtyDays,
      priorWindow: {
        startAt: "2026-03-18T00:00:00.000Z",
        endAt: startDate ?? "2026-05-17T00:00:00.000Z",
      },
      deltaPct: {
        state: BranchMetricAvailability.Complete,
        value: 4,
      } as const,
    },
  };
  return {
    period: BranchMetricPeriod.SixtyDays,
    label: BranchMetricComparisonLabel.PriorSixtyDays,
    window: {
      startAt: startDate ?? null,
      endAt: endDate ?? "2026-07-15T23:59:59.999Z",
    },
    cohortSize: 1,
    lastActiveAt: {
      state: BranchMetricAvailability.Complete,
      value: "2026-07-15T12:00:00.000Z",
    },
    activeBranches: metric,
    locPerDollar: metric,
    medianPrSize: metric,
    aiSpendUsd: metric,
    mergeRatePct: metric,
  };
}
