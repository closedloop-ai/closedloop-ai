import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { describeMissingBranchComparison } from "../../lib/branch-list-comparison-copy";
import { ApprovedBranchesSummaryCards } from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";

/**
 * ISS-5714: `MEDIAN PR SIZE` rendered `148 LOC*` with the bare word
 * `Unavailable` in the footer slot directly beneath it — a value and a denial of
 * that value in one tile. The value was real; only the period-over-period
 * comparison was missing, and the placeholder never said so.
 */
const PARTIAL_MEDIAN_PR_SIZE = {
  current: {
    state: BranchMetricAvailability.Partial,
    value: 148,
    coverage: { included: 4, total: 6 },
    disclosure: BranchMetricDisclosure.DefaultIncomplete,
  },
  comparison: {
    label: BranchMetricComparisonLabel.MonthOverMonth,
    priorWindow: {
      startAt: "2026-06-06T00:00:00.000Z",
      endAt: "2026-07-06T00:00:00.000Z",
    },
    deltaPct: {
      state: BranchMetricAvailability.Unavailable,
      value: null,
    },
  },
} as const;

function placeholderForMedian(): HTMLElement | undefined {
  return screen
    .getAllByTestId("kpi-delta-placeholder")
    .find((node) =>
      node.closest("[data-slot='card']")?.textContent?.includes("148 LOC")
    );
}

function renderApproved() {
  return render(
    <ApprovedBranchesSummaryCards
      cardClassName="card"
      isError={false}
      isPending={false}
      metrics={makeBranchListMetrics({
        medianPrSize: PARTIAL_MEDIAN_PR_SIZE,
      })}
    />
  );
}

describe("ApprovedBranchesSummaryCards (ISS-5714)", () => {
  it("never prints a bare denial under a value it did render", () => {
    renderApproved();

    // The value is real and still on screen.
    expect(screen.getByText("148 LOC*")).toBeInTheDocument();
    // …and nothing beside it says the unqualified word that reads as a denial
    // of that value. The three settled "Unavailable" captions in this row all
    // belong to cards whose VALUE is a dash, never to one showing a number.
    for (const denial of screen.queryAllByText("Unavailable")) {
      const card = denial.closest("[data-slot='card']");
      expect(card?.textContent).not.toContain("148 LOC");
    }
  });

  it("names the comparison as the missing thing, not the value", () => {
    renderApproved();

    const medianPlaceholder = placeholderForMedian();
    expect(medianPlaceholder).toBeDefined();
    expect(medianPlaceholder?.textContent).toContain("No comparison");
    // The reason travels with the chip in an `sr-only` sentence, and it scopes
    // the gap to the comparison window rather than to the value.
    expect(medianPlaceholder?.textContent).toContain(
      describeMissingBranchComparison({
        state: BranchMetricAvailability.Unavailable,
        label: BranchMetricComparisonLabel.MonthOverMonth,
        comparisonSuppressedByFilter: false,
      })
    );
  });

  /**
   * `approvedFilteredMetrics` blanks every delta when it recomputes the bundle
   * over the filtered rows, so THERE the cause is always the filter. Blaming the
   * period would make the reader's own data look like the problem (FEA-4241),
   * and it would tell a different story from the "Not available with filters
   * applied" caption the no-value cards in the same row already show.
   */
  it("blames the filter, not the period, when the filtered fallback suppressed the comparison", () => {
    render(
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        comparisonSuppressedByFilter
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          medianPrSize: PARTIAL_MEDIAN_PR_SIZE,
        })}
      />
    );

    const reason = placeholderForMedian()?.textContent ?? "";
    expect(reason).toContain("filters");
    expect(reason).not.toContain("month");
  });

  /**
   * `NotApplicable` means the prior window has no nonzero base — NOT that the
   * metric is never compared. A sibling card can be showing a live delta for the
   * same window, which would make that claim visibly false.
   */
  it("does not claim a metric is uncompared when only its baseline is missing", () => {
    render(
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          medianPrSize: {
            current: PARTIAL_MEDIAN_PR_SIZE.current,
            comparison: {
              ...PARTIAL_MEDIAN_PR_SIZE.comparison,
              deltaPct: {
                state: BranchMetricAvailability.NotApplicable,
                value: null,
              },
            },
          },
        })}
      />
    );

    const reason = placeholderForMedian()?.textContent ?? "";
    expect(reason).toContain("previous month");
    expect(reason).not.toContain("not compared");
  });

  /**
   * A chip reading "No comparison" over a caption reading "MoM" is the same
   * contradiction, one line down, that this card just stopped printing.
   */
  it("drops the bare window caption while the chip is explaining itself", () => {
    render(
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          activeBranches: {
            current: { state: BranchMetricAvailability.Complete, value: 12 },
            comparison: {
              ...PARTIAL_MEDIAN_PR_SIZE.comparison,
            },
          },
        })}
      />
    );

    const card = screen
      .getAllByTestId("kpi-delta-placeholder")[0]
      ?.closest("[data-slot='card']");
    expect(card?.textContent).toContain("12");
    expect(card?.textContent).not.toContain(
      BranchMetricComparisonLabel.MonthOverMonth
    );
  });

  it("renders no comparison affordance at all when none was promised", () => {
    render(
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          medianPrSize: { current: PARTIAL_MEDIAN_PR_SIZE.current },
        })}
      />
    );

    expect(screen.getByText("148 LOC*")).toBeInTheDocument();
    expect(screen.queryByTestId("kpi-delta-placeholder")).toBeNull();
  });
});
