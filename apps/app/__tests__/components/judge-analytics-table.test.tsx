/**
 * Unit tests for JudgeAnalyticsTable component.
 * Tests rendering of grouped Eval/Human columns per judge row.
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
  humanMin: null,
  humanMax: null,
  humanMean: null,
  humanStdDev: null,
};

const SECOND_JUDGE: JudgeAggregateStats = {
  judgeName: "brevity-judge",
  artifactsEvaluated: 5,
  min: 0.2,
  mean: 0.6,
  max: 0.9,
  stdDev: 0.2,
  humanMin: 0.4,
  humanMax: 1.0,
  humanMean: 0.7,
  humanStdDev: 0.15,
};

describe("JudgeAnalyticsTable", () => {
  describe("Grouped column headers", () => {
    it("renders Eval and Human group headers", () => {
      render(<JudgeAnalyticsTable data={[]} />);

      expect(screen.getByText("Eval")).toBeInTheDocument();
      expect(screen.getByText("Human")).toBeInTheDocument();
    });

    it("renders sub-column headers for both groups", () => {
      render(<JudgeAnalyticsTable data={[]} />);

      // Min, Max, Mean, Std Dev appear twice (Eval + Human)
      expect(screen.getAllByText("Min")).toHaveLength(2);
      expect(screen.getAllByText("Max")).toHaveLength(2);
      expect(screen.getAllByText("Mean")).toHaveLength(2);
      expect(screen.getAllByText("Std Dev")).toHaveLength(2);
    });

    it("renders Judge Name and Artifacts Evaluated headers", () => {
      render(<JudgeAnalyticsTable data={[]} />);

      expect(screen.getByText("Judge Name")).toBeInTheDocument();
      expect(screen.getByText("Artifacts Evaluated")).toBeInTheDocument();
    });
  });

  describe("Human stats columns", () => {
    it("shows dashes when judge has no human ratings", () => {
      render(<JudgeAnalyticsTable data={[BASE_JUDGE]} />);

      const rows = screen.getAllByRole("row");
      // Row 0 = group header, Row 1 = sub-header, Row 2 = judge
      const judgeCells = rows[2].querySelectorAll("td");
      // Human columns are indices 6-9 (after Judge Name, Artifacts, Eval Min/Max/Mean/StdDev)
      expect(judgeCells[6].textContent).toBe("\u2014");
      expect(judgeCells[7].textContent).toBe("\u2014");
      expect(judgeCells[8].textContent).toBe("\u2014");
      expect(judgeCells[9].textContent).toBe("\u2014");
    });

    it("shows formatted human stats when available", () => {
      render(<JudgeAnalyticsTable data={[SECOND_JUDGE]} />);

      const rows = screen.getAllByRole("row");
      const judgeCells = rows[2].querySelectorAll("td");
      expect(judgeCells[6].textContent).toBe("0.40"); // humanMin
      expect(judgeCells[7].textContent).toBe("1.00"); // humanMax
      expect(judgeCells[8].textContent).toBe("0.70"); // humanMean
      expect(judgeCells[9].textContent).toBe("0.15"); // humanStdDev
    });
  });

  describe("Eval stats columns", () => {
    it("renders eval stats formatted to two decimal places", () => {
      render(<JudgeAnalyticsTable data={[BASE_JUDGE]} />);

      const rows = screen.getAllByRole("row");
      const judgeCells = rows[2].querySelectorAll("td");
      expect(judgeCells[2].textContent).toBe("0.50"); // min
      expect(judgeCells[3].textContent).toBe("1.00"); // max
      expect(judgeCells[4].textContent).toBe("0.75"); // mean
      expect(judgeCells[5].textContent).toBe("0.15"); // stdDev
    });
  });

  describe("Judge rows", () => {
    it("renders one row per judge with name", () => {
      render(<JudgeAnalyticsTable data={[BASE_JUDGE, SECOND_JUDGE]} />);

      expect(screen.getByText("clarity-judge")).toBeInTheDocument();
      expect(screen.getByText("brevity-judge")).toBeInTheDocument();
    });

    it("renders artifactsEvaluated count", () => {
      render(<JudgeAnalyticsTable data={[BASE_JUDGE]} />);

      expect(screen.getByText("10")).toBeInTheDocument();
    });
  });
});
