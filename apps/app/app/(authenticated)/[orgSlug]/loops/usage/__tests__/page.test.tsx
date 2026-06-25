import { ApiError } from "@repo/app/shared/api/api-error";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoopUsagePage from "../page";

const { useLoopUsageMock } = vi.hoisted(() => ({
  useLoopUsageMock: vi.fn(),
}));

vi.mock("@repo/app/loops/hooks/use-loops", () => ({
  useLoopUsage: useLoopUsageMock,
}));

function mockUsageResult(
  overrides: Partial<ReturnType<typeof useLoopUsageMock>>
) {
  useLoopUsageMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  });
}

describe("LoopUsagePage error states", () => {
  beforeEach(() => {
    useLoopUsageMock.mockReset();
  });

  it("renders a permission-specific message when the API returns 403", () => {
    mockUsageResult({
      isError: true,
      error: new ApiError("Forbidden", 403),
    });

    render(<LoopUsagePage />);

    expect(screen.getByTestId("usage-error")).toBeInTheDocument();
    expect(
      screen.getByText("You don't have access to usage data")
    ).toBeInTheDocument();
    // The zero-filled summary grid must NOT render on error.
    expect(screen.queryByTestId("usage-summary-grid")).not.toBeInTheDocument();
  });

  it("renders a generic failure message for non-permission errors", () => {
    mockUsageResult({
      isError: true,
      error: new ApiError("Server error", 500),
    });

    render(<LoopUsagePage />);

    expect(screen.getByTestId("usage-error")).toBeInTheDocument();
    expect(screen.getByText("Failed to load usage data")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-summary-grid")).not.toBeInTheDocument();
  });

  it("renders the summary grid when data loads successfully", () => {
    mockUsageResult({
      data: {
        totalLoops: 0,
        totalTokensInput: 0,
        totalTokensOutput: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalEstimatedCost: 0,
        byCommand: [],
        byUser: [],
      },
    });

    render(<LoopUsagePage />);

    expect(screen.getByTestId("usage-summary-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-error")).not.toBeInTheDocument();
  });
});
