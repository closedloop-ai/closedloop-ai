import type { BranchAnalytics, BranchKpi } from "@repo/api/src/types/branch";
import { BranchKpiState } from "@repo/api/src/types/branch";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/use-branches", () => ({
  useBranchAnalytics: vi.fn(),
}));

import { useBranchAnalytics } from "../../hooks/use-branches";
import { BranchesSummaryCards } from "../branches-summary-cards";

const CONNECT_RE = /light up this metric/i;

function kpi(state: BranchKpiState, value: number | null): BranchKpi {
  return { value, state, baseline30d: null, deltaPct: null };
}

function makeAnalytics(): BranchAnalytics {
  return {
    viewerScope: "self",
    medianPrSize: kpi(BranchKpiState.Unavailable, null),
    mergeRate: kpi(BranchKpiState.Available, 87),
    medianTimeToMergeMs: kpi(BranchKpiState.Gated, null),
    activePrCount: kpi(BranchKpiState.Gated, null),
    mergedCount: kpi(BranchKpiState.Gated, null),
    leadTimeForChangeMs: kpi(BranchKpiState.Gated, null),
    locPerDollar: kpi(BranchKpiState.Unavailable, null),
    totalSpendUsd: kpi(BranchKpiState.Available, 1234.5),
    activeBranchCount: kpi(BranchKpiState.Available, 7),
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: BranchKpiState.Unavailable,
    },
  };
}

function mockAnalytics(data: BranchAnalytics | undefined) {
  vi.mocked(useBranchAnalytics).mockReturnValue({
    data,
    isLoading: data === undefined,
    isError: false,
  } as unknown as ReturnType<typeof useBranchAnalytics>);
}

describe("BranchesSummaryCards (B6 reconciliation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders only locally-computed cards and no connect-GitHub affordance", () => {
    mockAnalytics(makeAnalytics());
    render(<BranchesSummaryCards />);

    // Merge rate is available → real value, no Sample badge, no hardcoded 86.
    expect(screen.getByText("87%")).toBeInTheDocument();
    expect(screen.queryByText("86")).not.toBeInTheDocument();
    expect(screen.queryByText("Sample")).not.toBeInTheDocument();

    // The GitHub-free cards (FEA-2051) render real local values.
    expect(screen.getByText("$1,234.50")).toBeInTheDocument(); // AI spend
    expect(screen.getByText("7")).toBeInTheDocument(); // Active branches

    // FEA-2051: the GitHub-gated cards (Active PRs, Merged, Median time to merge)
    // are removed entirely — the row never shows the connect-GitHub affordance.
    expect(screen.queryByText(CONNECT_RE)).not.toBeInTheDocument();
    expect(screen.queryByText("Active PRs")).not.toBeInTheDocument();
    expect(screen.queryByText("Merged")).not.toBeInTheDocument();
    expect(screen.queryByText("Median time to merge")).not.toBeInTheDocument();
  });

  it("shows neutral placeholders while analytics is in flight", () => {
    mockAnalytics(undefined);
    render(<BranchesSummaryCards />);

    expect(screen.queryByText("87%")).not.toBeInTheDocument();
    expect(screen.queryByText(CONNECT_RE)).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(5);
  });
});
