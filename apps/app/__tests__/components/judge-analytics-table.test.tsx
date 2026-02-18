/**
 * Unit tests for JudgeAnalyticsTable component.
 * Tests conditional rendering of the "Human Rating" column and the
 * Human summary row based on whether humanRatingScore is provided.
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
};

const SECOND_JUDGE: JudgeAggregateStats = {
  judgeName: "brevity-judge",
  artifactsEvaluated: 5,
  min: 0.2,
  mean: 0.6,
  max: 0.9,
  stdDev: 0.2,
};

describe("JudgeAnalyticsTable", () => {
  describe("Human Rating column visibility", () => {
    it("omits Human Rating column header when humanRatingScore is null", () => {
      render(
        <JudgeAnalyticsTable data={[BASE_JUDGE]} humanRatingScore={null} />
      );

      expect(screen.queryByText("Human Rating")).not.toBeInTheDocument();
    });

    it("omits Human Rating column header when humanRatingScore is not provided", () => {
      render(<JudgeAnalyticsTable data={[BASE_JUDGE]} />);

      expect(screen.queryByText("Human Rating")).not.toBeInTheDocument();
    });

    it("shows Human Rating column header when humanRatingScore is a number", () => {
      render(
        <JudgeAnalyticsTable data={[BASE_JUDGE]} humanRatingScore={0.75} />
      );

      expect(screen.getByText("Human Rating")).toBeInTheDocument();
    });
  });

  describe("Human summary row", () => {
    it("shows humanRatingsCount in Human row", () => {
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

    it("renders Human row label regardless of counts", () => {
      render(<JudgeAnalyticsTable data={[BASE_JUDGE]} />);

      expect(screen.getByText("Human", { selector: "td" })).toBeInTheDocument();
    });

    it("shows formatted humanRatingScore in Human row when provided", () => {
      render(
        <JudgeAnalyticsTable
          data={[BASE_JUDGE]}
          humanCommentsCount={2}
          humanRatingScore={0.6}
          humanRatingsCount={5}
        />
      );

      expect(screen.getByText("0.60")).toBeInTheDocument();
    });

    it("omits formatted score cell from Human row when humanRatingScore is null", () => {
      render(
        <JudgeAnalyticsTable
          data={[BASE_JUDGE]}
          humanCommentsCount={2}
          humanRatingScore={null}
          humanRatingsCount={5}
        />
      );

      expect(screen.queryByText("0.60")).not.toBeInTheDocument();
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
      expect(screen.getByText("Human Ratings")).toBeInTheDocument();
      expect(screen.getByText("Human Comments")).toBeInTheDocument();
    });
  });
});
