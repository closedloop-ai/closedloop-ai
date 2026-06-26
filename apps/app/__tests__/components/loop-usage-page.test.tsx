/**
 * Unit tests for LoopUsagePage component.
 * Validates summary card presence and absence of removed cards.
 */

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUsage = {
  totalLoops: 42,
  totalTokensInput: 1_500_000,
  totalTokensOutput: 50_000,
  totalEstimatedCost: 12.34,
  totalCacheCreationTokens: 200_000,
  totalCacheReadTokens: 800_000,
  byCommand: [],
  byUser: [],
};

vi.mock("@repo/app/loops/hooks/use-loops", () => ({
  useLoopUsage: vi.fn(() => ({
    data: mockUsage,
    isLoading: false,
  })),
}));

vi.mock("next/image", () => ({
  __esModule: true,
  default: () => null,
}));

import { useLoopUsage } from "@repo/app/loops/hooks/use-loops";
import LoopUsagePage from "@/app/(authenticated)/[orgSlug]/loops/usage/page";

const SUMMARY_CARD_TITLES =
  /Total Loops|Input Tokens|Output Tokens|Cache Tokens|Estimated Cost/;

describe("LoopUsagePage — summary cards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders exactly 5 summary cards with correct titles", () => {
    render(<LoopUsagePage />);
    const grid = screen.getByTestId("usage-summary-grid");
    const cards = within(grid).getAllByText(SUMMARY_CARD_TITLES);
    expect(cards).toHaveLength(5);
    expect(within(grid).getByText("Total Loops")).toBeInTheDocument();
    expect(within(grid).getByText("Input Tokens")).toBeInTheDocument();
    expect(within(grid).getByText("Output Tokens")).toBeInTheDocument();
    expect(within(grid).getByText("Cache Tokens")).toBeInTheDocument();
    expect(within(grid).getByText("Estimated Cost")).toBeInTheDocument();
  });

  it("does not render Effective Tokens card", () => {
    render(<LoopUsagePage />);
    const grid = screen.getByTestId("usage-summary-grid");
    expect(
      within(grid).queryByText("Effective Tokens")
    ).not.toBeInTheDocument();
  });

  it("renders exactly 5 skeletons in loading state", () => {
    vi.mocked(useLoopUsage).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as ReturnType<typeof useLoopUsage>);

    const { container } = render(<LoopUsagePage />);
    const grid = container.querySelector('[data-testid="usage-summary-grid"]');
    expect(grid).not.toBeNull();
    // Each SummaryCardSkeleton renders 2 skeleton elements (header + content)
    const skeletons = grid!.querySelectorAll("[data-slot='skeleton']");
    expect(skeletons.length).toBe(10); // 5 cards * 2 skeletons each
  });
});
