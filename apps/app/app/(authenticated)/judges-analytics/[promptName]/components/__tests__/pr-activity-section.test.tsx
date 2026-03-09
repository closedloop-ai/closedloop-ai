import type { PrHealthResponse } from "@repo/api/src/types/judges-analytics";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PrActivitySection } from "../pr-activity-section";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@repo/analytics", () => ({
  analytics: { capture: vi.fn() },
}));

vi.mock("@repo/auth/client", () => ({
  useAuth: () => ({ orgId: "org-test", userId: "user-test" }),
}));

vi.mock("@repo/design-system/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div className={className} data-testid="skeleton" />
  ),
}));

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}));

vi.mock("../approval-distribution-chart", () => ({
  ApprovalDistributionChart: () => (
    <div data-testid="mock-approval-distribution-chart" />
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrHealthResponse(
  overrides?: Partial<PrHealthResponse>
): PrHealthResponse {
  return {
    totalPrs: 10,
    openPrs: 2,
    avgCommentCount: 3.5,
    totalCommentCount: 35,
    avgApprovalHours: 52,
    approvalDistribution: { lt1d: 1, "1to3d": 2, "3to7d": 3, gt7d: 4 },
    timeline: [],
    confidenceNote: "Based on 10 PRs",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PrActivitySection — loading state", () => {
  test("renders Skeleton elements when isLoading is true", () => {
    render(
      <PrActivitySection
        data={undefined}
        isError={false}
        isLoading={true}
        promptName="clarity"
      />
    );

    const skeletons = screen.getAllByTestId("skeleton");
    expect(skeletons.length).toBeGreaterThanOrEqual(2);
  });
});

describe("PrActivitySection — empty state", () => {
  test("renders empty message when totalPrs is 0", () => {
    render(
      <PrActivitySection
        data={makePrHealthResponse({
          totalPrs: 0,
          openPrs: 0,
          avgCommentCount: 0,
          avgApprovalHours: null,
        })}
        isError={false}
        isLoading={false}
        promptName="clarity"
      />
    );

    expect(
      screen.getByText(
        "No pull requests found for artifacts evaluated by this judge."
      )
    ).toBeTruthy();
  });
});

describe("PrActivitySection — summary card values", () => {
  test("renders totalPrs, avgCommentCount, formatted avgApprovalHours, and openPrs", () => {
    render(
      <PrActivitySection
        data={makePrHealthResponse()}
        isError={false}
        isLoading={false}
        promptName="clarity"
      />
    );

    // totalPrs: 10
    expect(screen.getByText("10")).toBeTruthy();
    // avgCommentCount.toFixed(1): "3.5"
    expect(screen.getByText("3.5")).toBeTruthy();
    // avgApprovalHours: 52 → formatDuration(52) = "2d 4h"
    expect(screen.getByText("2d 4h")).toBeTruthy();
    // openPrs: 2
    expect(screen.getByText("2")).toBeTruthy();
  });

  test("renders em dash for avgApprovalHours when null", () => {
    render(
      <PrActivitySection
        data={makePrHealthResponse({ avgApprovalHours: null })}
        isError={false}
        isLoading={false}
        promptName="clarity"
      />
    );

    expect(screen.getByText("—")).toBeTruthy();
  });

  test("renders confidenceNote text", () => {
    render(
      <PrActivitySection
        data={makePrHealthResponse()}
        isError={false}
        isLoading={false}
        promptName="clarity"
      />
    );

    expect(screen.getByText("Based on 10 PRs")).toBeTruthy();
  });
});

describe("PrActivitySection — tooltip content", () => {
  test("tooltip content describes comment metric scope", () => {
    render(
      <PrActivitySection
        data={makePrHealthResponse()}
        isError={false}
        isLoading={false}
        promptName="clarity"
      />
    );

    const tooltipContent = screen.getByTestId("tooltip-content");
    expect(tooltipContent.textContent).toContain(
      "Includes all review comments and general PR comments on artifacts evaluated by this judge."
    );
  });
});

describe("PrActivitySection — error state", () => {
  test("renders error message when isError is true", () => {
    render(
      <PrActivitySection
        data={undefined}
        isError={true}
        isLoading={false}
        promptName="clarity"
      />
    );

    expect(screen.getByText("Unable to load PR activity data.")).toBeTruthy();
  });
});
