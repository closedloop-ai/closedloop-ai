import { DocumentType } from "@repo/api/src/types/document";
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type {
  DocumentTypeGroup,
  JudgeStatsResponse,
} from "@repo/api/src/types/judges-analytics";
import { JUDGES_ANALYTICS_ALL_TIME_START_DATE } from "@repo/app/judges-analytics/lib/judges-analytics";
import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import JudgesAnalyticsPage from "../page";

// recharts' ResponsiveContainer (via ChartContainer) observes its box with a
// ResizeObserver, which jsdom does not implement.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {
      // no-op
    }
    unobserve() {
      // no-op
    }
    disconnect() {
      // no-op
    }
  } as unknown as typeof ResizeObserver;
});

// ISS-5037: the route now wraps its body in `FeatureFlagRouteGate` (Labs
// container flag OFF ⇒ notFound() ⇒ the in-shell "Page not found" recovery
// state). The flag-off / still-resolving branches are covered directly in
// `components/__tests__/feature-flag-route-gate.test.tsx`; these route tests
// exercise the flag-ON pass-through, so stub the gate to render its children
// and keep a `data-feature-flag` anchor for the wrapper-placement assertion.
vi.mock("@/components/feature-flag-route-gate", () => ({
  FeatureFlagRouteGate: ({
    children,
    flag,
  }: {
    children: ReactNode;
    flag: string;
  }) => <div data-feature-flag={flag}>{children}</div>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/test-org/judges-analytics",
  useSearchParams: () => new URLSearchParams(),
  useParams: vi.fn(() => ({ orgSlug: "test-org" })),
}));

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
}));

type StatsByReportType = Partial<
  Record<EvaluationReportType, JudgeStatsResponse>
>;

const emptyResponses: StatsByReportType = {
  [EvaluationReportType.Plan]: {
    reportType: EvaluationReportType.Plan,
    groups: [],
  },
  [EvaluationReportType.Prd]: {
    reportType: EvaluationReportType.Prd,
    groups: [],
  },
  [EvaluationReportType.Code]: {
    reportType: EvaluationReportType.Code,
    groups: [],
  },
};

const mockUseJudgesAnalytics = vi.fn();

vi.mock("@repo/app/judges-analytics/hooks/use-judges-analytics", () => ({
  useJudgesAnalytics: (
    startDate: string,
    endDate: string,
    reportType: EvaluationReportType
  ) => mockUseJudgesAnalytics(startDate, endDate, reportType),
}));

function planGroupWithData(): DocumentTypeGroup {
  return {
    documentType: DocumentType.ImplementationPlan,
    judges: [
      {
        judgeName: "gpt-4o",
        promptName: "gpt-4o",
        metricName: "gpt-4o",
        description: null,
        documentsEvaluated: 5,
        min: 0.2,
        mean: 0.6,
        max: 0.9,
        stdDev: 0.1,
        humanMin: null,
        humanMax: null,
        humanMean: null,
        humanStdDev: null,
      },
    ],
    humanRatingsCount: 0,
    humanCommentsCount: 0,
  };
}

afterEach(() => {
  cleanup();
  mockUseJudgesAnalytics.mockReset();
});

// ISS-5037: Judges is a Labs destination, so the ROUTE carries the Labs
// container gate — hiding the nav link while leaving this URL reachable would
// defeat the gate.
describe("JudgesAnalyticsPage - Labs route gate", () => {
  test("gates the page CONTENT while keeping the chrome outside the gate", () => {
    mockUseJudgesAnalytics.mockImplementation(
      (_start: string, _end: string, reportType: EvaluationReportType) => ({
        data: emptyResponses[reportType],
        isLoading: false,
        isError: false,
        error: null,
      })
    );

    render(<JudgesAnalyticsPage />);

    // The content is inside the container gate — hiding the nav link while
    // leaving this URL reachable would defeat the gate.
    const gate = document.querySelector(
      `[data-feature-flag="${LABS_NAV_SECTION_FEATURE_FLAG_KEY}"]`
    );
    expect(gate).not.toBeNull();
    expect(gate).toContainElement(
      screen.getByText("No evaluations in this range")
    );

    // ...but the chrome is OUTSIDE it. Gating the h1 and the description too
    // left the whole route rendering an empty region until PostHog settled
    // (bot review on PR #4341), so this placement is the fix, not an accident.
    expect(
      screen
        .getByRole("heading", { name: "Judges" })
        .closest("[data-feature-flag]")
    ).toBeNull();
  });
});

describe("JudgesAnalyticsPage - empty-state widen affordance", () => {
  test("offers a one-click widen when the default range is empty", () => {
    // Every report type resolves empty in the default (Month) window.
    mockUseJudgesAnalytics.mockImplementation(
      (_start: string, _end: string, reportType: EvaluationReportType) => ({
        data: emptyResponses[reportType],
        isLoading: false,
        isError: false,
        error: null,
      })
    );

    render(<JudgesAnalyticsPage />);

    // Not stranded on a bare dead-end: the actionable widen affordance renders.
    expect(
      screen.getByText("No evaluations in this range")
    ).toBeInTheDocument();
    const widenButton = screen.getByRole("button", { name: "Show all time" });
    expect(widenButton).toBeInTheDocument();
  });

  test("widening to all time re-queries with the all-time start date and shows data", () => {
    const allTimePlan: JudgeStatsResponse = {
      reportType: EvaluationReportType.Plan,
      groups: [planGroupWithData()],
    };

    // Empty in the default window, but data exists once the range is widened
    // to the all-time start date.
    mockUseJudgesAnalytics.mockImplementation(
      (start: string, _end: string, reportType: EvaluationReportType) => {
        const isAllTime = start === JUDGES_ANALYTICS_ALL_TIME_START_DATE;
        if (isAllTime && reportType === EvaluationReportType.Plan) {
          return {
            data: allTimePlan,
            isLoading: false,
            isError: false,
            error: null,
          };
        }
        return {
          data: emptyResponses[reportType],
          isLoading: false,
          isError: false,
          error: null,
        };
      }
    );

    render(<JudgesAnalyticsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Show all time" }));

    // Landed on a non-empty state after the widen.
    expect(mockUseJudgesAnalytics).toHaveBeenCalledWith(
      JUDGES_ANALYTICS_ALL_TIME_START_DATE,
      expect.any(String),
      EvaluationReportType.Plan
    );
    expect(
      screen.queryByText("No evaluations in this range")
    ).not.toBeInTheDocument();
    // Scope to the table's judge link so a chart axis tick with the same text
    // cannot make the query ambiguous.
    expect(screen.getByRole("link", { name: "gpt-4o" })).toBeInTheDocument();
  });

  test("shows a plain empty state with no widen affordance when all time is genuinely empty", () => {
    // No data in any range, including all time.
    mockUseJudgesAnalytics.mockImplementation(
      (_start: string, _end: string, reportType: EvaluationReportType) => ({
        data: emptyResponses[reportType],
        isLoading: false,
        isError: false,
        error: null,
      })
    );

    render(<JudgesAnalyticsPage />);

    // Drive the terminal branch through the empty-state widen action itself, so
    // this asserts that Show all time lands on the genuinely-empty state — not
    // merely that the filter's "All time" pill does.
    fireEvent.click(screen.getByRole("button", { name: "Show all time" }));

    expect(screen.getByText("No judge evaluations found")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show all time" })
    ).not.toBeInTheDocument();
  });

  test("shows the error alert and no empty state when a query fails with cached empty data", () => {
    // Cached empty results survive a failed refetch: every query still exposes
    // empty `data` while `isError` is true. The error branch must win.
    mockUseJudgesAnalytics.mockImplementation(
      (_start: string, _end: string, reportType: EvaluationReportType) => ({
        data: emptyResponses[reportType],
        isLoading: false,
        isError: true,
        error: new Error("boom"),
      })
    );

    render(<JudgesAnalyticsPage />);

    expect(screen.getByText("Error loading analytics")).toBeInTheDocument();
    // The failed request must not also render a terminal empty state.
    expect(
      screen.queryByText("No evaluations in this range")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("No judge evaluations found")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show all time" })
    ).not.toBeInTheDocument();
  });
});
