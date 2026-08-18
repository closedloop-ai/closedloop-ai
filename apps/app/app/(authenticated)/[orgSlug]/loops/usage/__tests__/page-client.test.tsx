import { ApiError } from "@repo/app/shared/api/api-error";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoopUsagePageClient from "../page-client";

const AS_OF_PATTERN = /as of/i;
const NOT_UNIT_RATES_PATTERN = /not.*unit rates/i;

const EMPTY_USAGE = {
  totalLoops: 0,
  totalTokensInput: 0,
  totalTokensOutput: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  totalEstimatedCost: 0,
  byCommand: [],
  byUser: [],
};

const { useLoopUsageMock } = vi.hoisted(() => ({
  useLoopUsageMock: vi.fn(),
}));

vi.mock("@repo/app/loops/hooks/use-loops", () => ({
  useLoopUsage: useLoopUsageMock,
}));

// Stub the app Header: it renders a SidebarTrigger that requires a
// SidebarProvider context this unit test does not mount. ISS-4477 added the
// Header to give the now-direct-URL-only Usage route a way back out; the
// breadcrumb label is asserted in the render below.
vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({ breadcrumbs }: { breadcrumbs: { label: string }[] }) => (
    <div data-testid="header">
      {breadcrumbs.map((crumb) => (
        <span key={crumb.label}>{crumb.label}</span>
      ))}
    </div>
  ),
}));

function mockUsageResult(
  overrides: Partial<ReturnType<typeof useLoopUsageMock>>
) {
  useLoopUsageMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    // React Query surfaces `dataUpdatedAt` (epoch ms; 0 until first success).
    // Success-path mocks set a non-zero stamp so the "as of" indicator renders.
    dataUpdatedAt: overrides.data === undefined ? 0 : Date.now(),
    ...overrides,
  });
}

describe("LoopUsagePageClient error states", () => {
  beforeEach(() => {
    useLoopUsageMock.mockReset();
  });

  // ISS-4477: the Loops list (this route's former entry point) is retired, so
  // the flag-gated Usage route is now reached only by direct URL. It must still
  // render the Header/breadcrumb so it is not a doorless screen.
  it("renders the Header breadcrumb so the route has a way back out", () => {
    mockUsageResult({ data: EMPTY_USAGE });

    render(<LoopUsagePageClient />);

    const header = screen.getByTestId("header");
    expect(header).toBeInTheDocument();
    expect(header).toHaveTextContent("Usage");
  });

  it("renders a permission-specific message when the API returns 403", () => {
    mockUsageResult({
      isError: true,
      error: new ApiError("Forbidden", 403),
    });

    render(<LoopUsagePageClient />);

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

    render(<LoopUsagePageClient />);

    expect(screen.getByTestId("usage-error")).toBeInTheDocument();
    expect(screen.getByText("Failed to load usage data")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-summary-grid")).not.toBeInTheDocument();
  });

  it("renders the summary grid when data loads successfully", () => {
    mockUsageResult({ data: EMPTY_USAGE });

    render(<LoopUsagePageClient />);

    expect(screen.getByTestId("usage-summary-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-error")).not.toBeInTheDocument();
  });
});

describe("LoopUsagePageClient time-window scoping (FEA-1541)", () => {
  beforeEach(() => {
    useLoopUsageMock.mockReset();
  });

  it("defaults to the 30-day window and passes its start date to the query", () => {
    mockUsageResult({ data: EMPTY_USAGE });

    render(<LoopUsagePageClient />);

    // Default scope is 30d → a bounded startDate is sent (not undefined/all-time).
    const filters = useLoopUsageMock.mock.calls.at(-1)?.[0];
    expect(filters?.startDate).toEqual(expect.any(String));
  });

  it("offers a Today window and switches the query to it in-place (AC-007.1/007.3)", () => {
    mockUsageResult({ data: EMPTY_USAGE });

    render(<LoopUsagePageClient />);

    const todayToggle = screen.getByText("Today");
    fireEvent.click(todayToggle);

    // In-place update: no remount, and the query re-runs with a tighter window.
    const filters = useLoopUsageMock.mock.calls.at(-1)?.[0];
    expect(filters?.startDate).toEqual(expect.any(String));
    expect(screen.getByTestId("usage-summary-grid")).toBeInTheDocument();
  });

  it("offers an All time window that sends an unbounded (undefined) start date", () => {
    mockUsageResult({ data: EMPTY_USAGE });

    render(<LoopUsagePageClient />);

    fireEvent.click(screen.getByText("All time"));

    const filters = useLoopUsageMock.mock.calls.at(-1)?.[0];
    expect(filters?.startDate).toBeUndefined();
  });

  it("shows an 'as of' timestamp once data has loaded (AC-007.2)", () => {
    mockUsageResult({ data: EMPTY_USAGE });

    render(<LoopUsagePageClient />);

    expect(screen.getByTestId("usage-as-of")).toBeInTheDocument();
    expect(screen.getByTestId("usage-as-of")).toHaveTextContent(AS_OF_PATTERN);
  });

  it("does not show the 'as of' timestamp on error", () => {
    mockUsageResult({ isError: true, error: new ApiError("boom", 500) });

    render(<LoopUsagePageClient />);

    expect(screen.queryByTestId("usage-as-of")).not.toBeInTheDocument();
  });

  it("labels the cost breakdowns as accumulated usage totals, not unit rates (AC-008.1)", () => {
    mockUsageResult({ data: EMPTY_USAGE });

    render(<LoopUsagePageClient />);

    expect(screen.getAllByText(NOT_UNIT_RATES_PATTERN).length).toBeGreaterThan(
      0
    );
  });
});
