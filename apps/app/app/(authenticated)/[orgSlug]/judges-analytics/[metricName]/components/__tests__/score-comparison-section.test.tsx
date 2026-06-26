import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type { JudgeScoresResponse } from "@repo/api/src/types/judges-analytics";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ScoreComparisonSection } from "../score-comparison-section";

const mockUseJudgeScores = vi.fn();

vi.mock("@repo/app/judges-analytics/hooks/use-judge-scores", () => ({
  useJudgeScores: (..._args: unknown[]) => mockUseJudgeScores(),
}));

vi.mock("../score-comparison-table", () => ({
  ScoreComparisonTable: ({ rows }: { rows: Array<{ documentId: string }> }) => (
    <div data-testid="mock-score-table">rows-count:{rows.length}</div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("ScoreComparisonSection", () => {
  test("shows aggregate averages from visible rows", () => {
    mockUseJudgeScores.mockReturnValue({
      isLoading: false,
      isError: false,
      data: makeResponse(makeRows(5, 0.8, 0.6)),
    });

    render(
      <ScoreComparisonSection
        promptName="clarity"
        reportType={EvaluationReportType.Plan}
      />
    );

    expect(
      screen.getByText("Averages (visible): Judge 80% · Human 60%")
    ).toBeTruthy();
  });

  test("caps rendered rows at 20 artifacts", () => {
    mockUseJudgeScores.mockReturnValue({
      isLoading: false,
      isError: false,
      data: makeResponse(makeRows(25, 0.7, 0.5)),
    });

    render(
      <ScoreComparisonSection
        promptName="clarity"
        reportType={EvaluationReportType.Plan}
      />
    );

    expect(screen.getByTestId("mock-score-table").textContent).toContain(
      "rows-count:20"
    );
  });
});

function makeResponse(rows: JudgeScoresResponse["rows"]): JudgeScoresResponse {
  return {
    rows,
    totalDocuments: rows.length,
    ratedDocuments: rows.filter((row) => row.userRatingCount > 0).length,
    coveragePct: 0,
    pagination: {
      page: 1,
      pageSize: 20,
      totalRows: rows.length,
      totalPages: 1,
    },
  };
}

function makeRows(
  count: number,
  judgeScore: number,
  avgUserRating: number
): JudgeScoresResponse["rows"] {
  return Array.from({ length: count }, (_, index) => ({
    judgeScoreId: `js-artifact-${index + 1}`,
    metricName: `metric-${index + 1}`,
    documentId: `artifact-${index + 1}`,
    documentType: "IMPLEMENTATION_PLAN",
    documentTitle: `Artifact ${index + 1}`,
    documentSlug: `artifact-${index + 1}`,
    judgeScore,
    avgUserRating,
    userRatingCount: 1,
    delta: Math.abs(avgUserRating - judgeScore),
    evaluatedAt: "2026-01-15T00:00:00.000Z",
  }));
}
