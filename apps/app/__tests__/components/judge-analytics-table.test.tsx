/**
 * Unit tests for JudgeAnalyticsTable component.
 * Tests rendering of the "Human Rating" column per judge row
 * and the Human summary row.
 */
import type { JudgeAggregateStats } from "@repo/api/src/types/judges-analytics";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { JudgeAnalyticsTable } from "@/app/(authenticated)/judges-analytics/components/judge-analytics-table";

const BASE_JUDGE: JudgeAggregateStats = {
  judgeName: "clarity-judge",
  artifactsEvaluated: 10,
  min: 0.5,
  mean: 0.75,
  max: 1.0,
  stdDev: 0.15,
  humanRatingScore: null,
};

const SECOND_JUDGE: JudgeAggregateStats = {
  judgeName: "brevity-judge",
  artifactsEvaluated: 5,
  min: 0.2,
  mean: 0.6,
  max: 0.9,
  stdDev: 0.2,
  humanRatingScore: 0.8,
};

describe("JudgeAnalyticsTable", () => {
  describe("Human Rating column", () => {
    it("always renders Human Rating column header", () => {
      render(<JudgeAnalyticsTable data={[BASE_JUDGE]} />);

      expect(screen.getByText("Human Rating")).toBeInTheDocument();
    });

    it("shows dash when judge has no human rating", () => {
      render(<JudgeAnalyticsTable data={[BASE_JUDGE]} />);

      // The judge row should have a dash for human rating
      const rows = screen.getAllByRole("row");
      // Row 0 = header, Row 1 = judge, Row 2 = Human summary
      const judgeCells = rows[1].querySelectorAll("td");
      // Human Rating is column index 6
      expect(judgeCells[6].textContent).toBe("—");
    });

    it("shows formatted score when judge has human rating", () => {
      render(<JudgeAnalyticsTable data={[SECOND_JUDGE]} />);

      expect(screen.getByText("0.80")).toBeInTheDocument();
    });
  });

  describe("Human summary row", () => {
    it("shows humanRatingsCount and humanCommentsCount", () => {
      render(
        <JudgeAnalyticsTable
          data={[BASE_JUDGE]}
          humanCommentsCount={7}
          humanRatingsCount={42}
        />
      );

      expect(screen.getByText("42")).toBeInTheDocument();
      expect(screen.getByText("7")).toBeInTheDocument();
    });

    it("renders Human row label", () => {
      render(<JudgeAnalyticsTable data={[BASE_JUDGE]} />);

      expect(screen.getByText("Human", { selector: "td" })).toBeInTheDocument();
    });
  });

  describe("Judge rows", () => {
    it("renders one row per judge with name", () => {
      render(<JudgeAnalyticsTable data={[BASE_JUDGE, SECOND_JUDGE]} />);

      expect(screen.getByText("clarity-judge")).toBeInTheDocument();
      expect(screen.getByText("brevity-judge")).toBeInTheDocument();
    });

    it("renders judge stats formatted to two decimal places", () => {
      render(<JudgeAnalyticsTable data={[BASE_JUDGE]} />);

      expect(screen.getByText("0.50")).toBeInTheDocument();
      expect(screen.getByText("0.75")).toBeInTheDocument();
      expect(screen.getByText("1.00")).toBeInTheDocument();
      expect(screen.getByText("0.15")).toBeInTheDocument();
    });

    it("renders artifactsEvaluated count for each judge", () => {
      render(<JudgeAnalyticsTable data={[BASE_JUDGE]} />);

      expect(screen.getByText("10")).toBeInTheDocument();
    });
  });

  describe("Fixed column headers", () => {
    it("always renders standard column headers", () => {
      render(<JudgeAnalyticsTable data={[]} />);

      expect(screen.getByText("Judge Name")).toBeInTheDocument();
      expect(screen.getByText("Artifacts Evaluated")).toBeInTheDocument();
      expect(screen.getByText("Min")).toBeInTheDocument();
      expect(screen.getByText("Mean")).toBeInTheDocument();
      expect(screen.getByText("Max")).toBeInTheDocument();
      expect(screen.getByText("Std Dev")).toBeInTheDocument();
      expect(screen.getByText("Human Rating")).toBeInTheDocument();
      expect(screen.getByText("Human Ratings")).toBeInTheDocument();
      expect(screen.getByText("Human Comments")).toBeInTheDocument();
    });
  });
});
