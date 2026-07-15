import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// FEA-3156: the summary cards read the three delivery metrics off the usage
// query. Mock the hook directly so the test asserts the card wiring (real value
// vs. "Sample" placeholder) without standing up react-query + a data source.
const useAgentSessionUsage = vi.fn();
vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionUsage: (...args: unknown[]) => useAgentSessionUsage(...args),
}));

import { SessionsSummaryCards } from "../sessions-summary-cards";

const RAW_TOTAL_DETAIL_PATTERN = /\$100\.00 incl\. subscription/;

function usageFixture(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return {
    viewerScope: AgentSessionViewerScope.Organization,
    totalSessions: 12,
    earliestSessionAt: null,
    latestSessionAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 42,
    subscriptionEstimatedCost: 0,
    apiEstimatedCost: 42,
    byUser: [],
    byModel: [],
    byHarness: [],
    byRepository: [],
    lastSyncTargets: [],
    ...overrides,
  };
}

describe("SessionsSummaryCards — delivery metrics", () => {
  it("renders real delivery values (no Sample badge) when merged PRs exist", () => {
    useAgentSessionUsage.mockReturnValue({
      isLoading: false,
      data: usageFixture({
        mergedPrCount: 7,
        medianPrSize: 2000,
        mergedKlocPerDollar: 3.5,
      }),
    });

    render(<SessionsSummaryCards filters={{}} />);

    // Delivery values render for real — not the "—" placeholder.
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("2,000")).toBeInTheDocument();
    expect(screen.getByText("3.50")).toBeInTheDocument();
    // No card is flagged as sample data when the metrics are present.
    expect(screen.queryByText("Sample")).toBeNull();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("Cost card headline is metered apiEstimatedCost, not the raw subscription-inclusive total (same basis as KLOC/$)", () => {
    // FEA-3156 mixed-basis guard: the KLOC-per-dollar card divides by the
    // metered API cost (subscription-excluded). The adjacent Cost card must sit
    // on the SAME basis — its headline is apiEstimatedCost, NOT the raw
    // totalEstimatedCost that folds subscription-covered "would-have-cost" in.
    useAgentSessionUsage.mockReturnValue({
      isLoading: false,
      data: usageFixture({
        // $100 raw total, of which only $30 is real metered API spend and $70
        // is subscription-covered. The headline must be $30, not $100.
        totalEstimatedCost: 100,
        apiEstimatedCost: 30,
        subscriptionEstimatedCost: 70,
      }),
    });

    render(<SessionsSummaryCards filters={{}} />);

    // Headline is the metered basis ($30), matching the KLOC/$ denominator.
    expect(screen.getByText("$30.00")).toBeInTheDocument();
    // The raw total is surfaced only in the detail line ("incl. subscription"),
    // never promoted to the headline.
    expect(screen.queryByText("$100.00")).toBeNull();
    expect(screen.getByText(RAW_TOTAL_DETAIL_PATTERN)).toBeInTheDocument();
  });

  it("keeps the placeholder + Sample badge only where a metric is unavailable", () => {
    useAgentSessionUsage.mockReturnValue({
      isLoading: false,
      // Merged PRs exist (count 4) but there is no measurable size / efficiency
      // (null) — the count renders real, the other two stay placeholders.
      data: usageFixture({
        mergedPrCount: 4,
        medianPrSize: null,
        mergedKlocPerDollar: null,
      }),
    });

    render(<SessionsSummaryCards filters={{}} />);

    // PRs Shipped shows the real count with no badge on that value.
    expect(screen.getByText("4")).toBeInTheDocument();
    // The two unavailable metrics still render a dashed placeholder + a Sample
    // badge each (median PR size + KLOC/$).
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getAllByText("Sample")).toHaveLength(2);
  });
});
