import type { JudgeAggregateStats } from "@repo/api/src/types/judges-analytics";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { JudgeAnalyticsTable } from "../judge-analytics-table";

function makeJudge(
  overrides?: Partial<JudgeAggregateStats>
): JudgeAggregateStats {
  return {
    judgeName: "gpt-4o",
    artifactsEvaluated: 10,
    min: 1.5,
    mean: 3.5,
    max: 5.0,
    stdDev: 0.8,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("JudgeAnalyticsTable - smoke test", () => {
  test("renders the table with column headers", () => {
    render(
      <JudgeAnalyticsTable
        data={[]}
        humanCommentsCount={0}
        humanRatingsCount={0}
      />
    );

    expect(screen.getByText("Judge Name")).toBeInTheDocument();
    expect(screen.getByText("Artifacts Evaluated")).toBeInTheDocument();
    expect(screen.getByText("Min")).toBeInTheDocument();
    expect(screen.getByText("Mean")).toBeInTheDocument();
    expect(screen.getByText("Max")).toBeInTheDocument();
    expect(screen.getByText("Std Dev")).toBeInTheDocument();
    expect(screen.getByText("Human Ratings")).toBeInTheDocument();
    expect(screen.getByText("Human Comments")).toBeInTheDocument();
  });

  test("renders Human row even when data array is empty", () => {
    render(<JudgeAnalyticsTable data={[]} />);

    expect(screen.getByText("Human")).toBeInTheDocument();
  });

  test("renders judge data rows with correct values", () => {
    const judges: JudgeAggregateStats[] = [
      makeJudge({
        judgeName: "claude-opus",
        mean: 4.2,
        min: 2.0,
        max: 5.0,
        stdDev: 0.5,
        artifactsEvaluated: 20,
      }),
    ];

    render(<JudgeAnalyticsTable data={judges} />);

    expect(screen.getByText("claude-opus")).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
    expect(screen.getByText("2.00")).toBeInTheDocument();
    expect(screen.getByText("4.20")).toBeInTheDocument();
    expect(screen.getByText("5.00")).toBeInTheDocument();
    expect(screen.getByText("0.50")).toBeInTheDocument();
  });

  test("displays humanRatingsCount and humanCommentsCount in Human row", () => {
    render(
      <JudgeAnalyticsTable
        data={[]}
        humanCommentsCount={17}
        humanRatingsCount={42}
      />
    );

    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("17")).toBeInTheDocument();
  });

  test("defaults humanRatingsCount and humanCommentsCount to 0 when not provided", () => {
    render(<JudgeAnalyticsTable data={[]} />);

    const rows = screen.getAllByRole("row");
    const humanRow = rows.at(-1);
    expect(
      within(humanRow as HTMLElement).getByText("Human")
    ).toBeInTheDocument();
  });
});

describe("JudgeAnalyticsTable - Human row pinning", () => {
  const judges: JudgeAggregateStats[] = [
    makeJudge({
      judgeName: "zebra-judge",
      mean: 1.0,
      min: 1.0,
      max: 1.0,
      stdDev: 0.0,
      artifactsEvaluated: 5,
    }),
    makeJudge({
      judgeName: "alpha-judge",
      mean: 5.0,
      min: 5.0,
      max: 5.0,
      stdDev: 0.0,
      artifactsEvaluated: 3,
    }),
    makeJudge({
      judgeName: "middle-judge",
      mean: 3.0,
      min: 2.0,
      max: 4.0,
      stdDev: 0.5,
      artifactsEvaluated: 8,
    }),
  ];

  test("Human row is always the last row in the table body", () => {
    render(<JudgeAnalyticsTable data={judges} />);

    const rows = screen.getAllByRole("row");
    // rows[0] is the header row, subsequent rows are data rows, last is Human
    const lastRow = rows.at(-1);
    expect(
      within(lastRow as HTMLElement).getByText("Human")
    ).toBeInTheDocument();
  });

  test("data rows appear before Human row", () => {
    render(<JudgeAnalyticsTable data={judges} />);

    const rows = screen.getAllByRole("row");
    // Header row + 3 data rows + Human row = 5 rows total
    expect(rows).toHaveLength(5);

    expect(screen.getByText("zebra-judge")).toBeInTheDocument();
    expect(screen.getByText("alpha-judge")).toBeInTheDocument();
    expect(screen.getByText("middle-judge")).toBeInTheDocument();
    expect(screen.getByText("Human")).toBeInTheDocument();
  });
});
