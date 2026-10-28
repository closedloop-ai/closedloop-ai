import {
  BranchMetricAvailability,
  BranchMetricId,
} from "@repo/api/src/types/branch-metrics";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovedBranchesSummaryCards } from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";

/**
 * ISS-12664 — the reader's own hide choice. Labels are literals on purpose: a
 * label read from the dictionary would move with the card it polices.
 */
const ALL_LABELS = [
  "Active branches",
  "Median PR size",
  "Total LOC pushed",
  "Merge rate",
  "LOC per $",
];

function complete(value: number) {
  return {
    current: { state: BranchMetricAvailability.Complete, value },
  } as const;
}

function renderStrip(hiddenCardIds?: ReadonlySet<string>) {
  return render(
    <ApprovedBranchesSummaryCards
      cardClassName="card"
      hiddenCardIds={hiddenCardIds}
      isError={false}
      isPending={false}
      metrics={makeBranchListMetrics({
        activeBranches: complete(12),
        medianPrSize: complete(148),
        mergeRatePct: complete(85),
        pushedLocPerDollar: complete(4),
        totalLocPushed: complete(1000),
      })}
    />
  );
}

describe("ApprovedBranchesSummaryCards reader-hidden cards", () => {
  it("paints all five when nothing is hidden", () => {
    renderStrip(new Set());

    for (const label of ALL_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("removes only the hidden card and leaves every other figure as computed", () => {
    renderStrip(new Set([BranchMetricId.MedianPrSize]));

    expect(screen.queryByText("Median PR size")).toBeNull();
    expect(screen.queryByText("148 LOC")).toBeNull();
    // Positive halves: the neighbours still paint the values they paint unhidden.
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("1,000 LOC")).toBeInTheDocument();
    expect(screen.getByText("Merge rate")).toBeInTheDocument();
  });

  it("renders no strip when every card is hidden", () => {
    const { container } = renderStrip(new Set(Object.values(BranchMetricId)));

    expect(container).toBeEmptyDOMElement();
  });
});
