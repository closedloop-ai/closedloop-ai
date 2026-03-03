import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type { JudgeAggregateStats } from "@repo/api/src/types/judges-analytics";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JudgeAnalyticsTable } from "../judge-analytics-table";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/judges-analytics",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
}));

function makeJudge(
  overrides?: Partial<JudgeAggregateStats>
): JudgeAggregateStats {
  return {
    judgeName: "gpt-4o",
    promptName: "gpt-4o",
    description: null,
    artifactsEvaluated: 10,
    min: 1.5,
    mean: 3.5,
    max: 5.0,
    stdDev: 0.8,
    humanMin: null,
    humanMax: null,
    humanMean: null,
    humanStdDev: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("JudgeAnalyticsTable - grouped column headers", () => {
  test("renders Eval and Human group headers", () => {
    render(
      <JudgeAnalyticsTable data={[]} reportType={EvaluationReportType.Plan} />
    );

    expect(screen.getByText("Eval")).toBeInTheDocument();
    expect(screen.getByText("Human")).toBeInTheDocument();
  });

  test("renders sub-column headers for both groups", () => {
    render(
      <JudgeAnalyticsTable data={[]} reportType={EvaluationReportType.Plan} />
    );

    expect(screen.getAllByText("Min")).toHaveLength(2);
    expect(screen.getAllByText("Max")).toHaveLength(2);
    expect(screen.getAllByText("Mean")).toHaveLength(2);
    expect(screen.getAllByText("Std Dev")).toHaveLength(2);
  });

  test("renders Judge Name and Artifacts Evaluated headers", () => {
    render(
      <JudgeAnalyticsTable data={[]} reportType={EvaluationReportType.Plan} />
    );

    expect(screen.getByText("Judge Name")).toBeInTheDocument();
    expect(screen.getByText("Artifacts Evaluated")).toBeInTheDocument();
  });
});

describe("JudgeAnalyticsTable - eval stats columns", () => {
  test("renders eval stats formatted to two decimal places", () => {
    render(
      <JudgeAnalyticsTable
        data={[
          makeJudge({
            judgeName: "claude-opus",
            min: 2.0,
            max: 5.0,
            mean: 4.2,
            stdDev: 0.5,
            artifactsEvaluated: 20,
          }),
        ]}
        reportType={EvaluationReportType.Plan}
      />
    );

    expect(screen.getByText("claude-opus")).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
    expect(screen.getByText("2.00")).toBeInTheDocument();
    expect(screen.getByText("4.20")).toBeInTheDocument();
    expect(screen.getByText("5.00")).toBeInTheDocument();
    expect(screen.getByText("0.50")).toBeInTheDocument();
  });
});

describe("JudgeAnalyticsTable - human stats columns", () => {
  test("shows dashes when judge has no human ratings", () => {
    render(
      <JudgeAnalyticsTable
        data={[makeJudge()]}
        reportType={EvaluationReportType.Plan}
      />
    );

    const rows = screen.getAllByRole("row");
    // Row 0 = group header, Row 1 = sub-header, Row 2 = judge
    const judgeCells = rows[2].querySelectorAll("td");
    // Human columns are indices 6-9 (after Judge Name, Artifacts, Eval Min/Max/Mean/StdDev)
    expect(judgeCells[6].textContent).toBe("\u2014");
    expect(judgeCells[7].textContent).toBe("\u2014");
    expect(judgeCells[8].textContent).toBe("\u2014");
    expect(judgeCells[9].textContent).toBe("\u2014");
  });

  test("shows formatted human stats when available", () => {
    render(
      <JudgeAnalyticsTable
        data={[
          makeJudge({
            humanMin: 0.4,
            humanMax: 1.0,
            humanMean: 0.7,
            humanStdDev: 0.15,
          }),
        ]}
        reportType={EvaluationReportType.Plan}
      />
    );

    const rows = screen.getAllByRole("row");
    const judgeCells = rows[2].querySelectorAll("td");
    expect(judgeCells[6].textContent).toBe("0.40");
    expect(judgeCells[7].textContent).toBe("1.00");
    expect(judgeCells[8].textContent).toBe("0.70");
    expect(judgeCells[9].textContent).toBe("0.15");
  });
});

describe("JudgeAnalyticsTable - judge rows", () => {
  test("renders one row per judge with name", () => {
    render(
      <JudgeAnalyticsTable
        data={[
          makeJudge({ judgeName: "clarity-judge" }),
          makeJudge({ judgeName: "brevity-judge" }),
        ]}
        reportType={EvaluationReportType.Plan}
      />
    );

    expect(screen.getByText("clarity-judge")).toBeInTheDocument();
    expect(screen.getByText("brevity-judge")).toBeInTheDocument();
  });

  test("renders artifactsEvaluated count", () => {
    render(
      <JudgeAnalyticsTable
        data={[makeJudge({ artifactsEvaluated: 10 })]}
        reportType={EvaluationReportType.Plan}
      />
    );

    expect(screen.getByText("10")).toBeInTheDocument();
  });

  test("includes reportType in judge detail links", () => {
    render(
      <JudgeAnalyticsTable
        data={[
          makeJudge({ judgeName: "clarity-judge", promptName: "clarity" }),
        ]}
        reportType={EvaluationReportType.Code}
      />
    );

    const link = screen.getByRole("link", { name: "clarity-judge" });
    expect(link).toHaveAttribute(
      "href",
      "/judges-analytics/clarity?reportType=CODE"
    );
  });

  test("shows tooltip content from API description", () => {
    render(
      <JudgeAnalyticsTable
        data={[
          makeJudge({
            judgeName: "clarity-judge",
            promptName: "clarity",
            description: "Judge description from prompt registry",
          }),
        ]}
        reportType={EvaluationReportType.Plan}
      />
    );

    expect(
      screen.getByText("Judge description from prompt registry")
    ).toBeInTheDocument();
  });
});
