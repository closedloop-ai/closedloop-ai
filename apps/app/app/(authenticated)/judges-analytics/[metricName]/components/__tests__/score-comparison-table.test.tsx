import type { JudgeScoreRow } from "@repo/api/src/types/judges-analytics";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ScoreComparisonTable } from "../score-comparison-table";

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
}));

const PARENTHESIZED_COUNT_REGEX = /\(\d+\)/;

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeRow(overrides?: Partial<JudgeScoreRow>): JudgeScoreRow {
  return {
    judgeScoreId: "js-1",
    metricName: "my-implementation-plan",
    artifactId: "artifact-1",
    artifactType: "IMPLEMENTATION_PLAN",
    artifactTitle: "My Implementation Plan",
    artifactSlug: "my-implementation-plan",
    judgeScore: 0.8,
    avgUserRating: 0.8,
    userRatingCount: 0,
    delta: 0,
    evaluatedAt: "2026-01-15T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ScoreComparisonTable — empty state", () => {
  test("renders empty state message when rows is empty", () => {
    render(<ScoreComparisonTable rows={[]} />);

    expect(screen.getByText("No score data available.")).toBeTruthy();
  });

  test("does not render a table when rows is empty", () => {
    render(<ScoreComparisonTable rows={[]} />);

    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("ScoreComparisonTable — artifact links", () => {
  test("renders artifact title as link to implementation plan", () => {
    render(<ScoreComparisonTable rows={[makeRow()]} />);

    const link = screen.getByRole("link", { name: "My Implementation Plan" });
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe(
      "/implementation-plans/my-implementation-plan"
    );
  });

  test("uses artifact-specific route prefix for PRD rows", () => {
    render(
      <ScoreComparisonTable
        rows={[
          makeRow({
            artifactType: "PRD",
            artifactTitle: "Product Requirements",
            artifactSlug: "product-requirements",
          }),
        ]}
      />
    );

    const link = screen.getByRole("link", { name: "Product Requirements" });
    expect(link.getAttribute("href")).toBe("/prds/product-requirements");
  });

  test("renders one link per row", () => {
    render(
      <ScoreComparisonTable
        rows={[
          makeRow({
            judgeScoreId: "js-a1",
            artifactId: "a1",
            artifactTitle: "Plan A",
            artifactSlug: "plan-a",
          }),
          makeRow({
            judgeScoreId: "js-a2",
            artifactId: "a2",
            artifactTitle: "Plan B",
            artifactSlug: "plan-b",
          }),
        ]}
      />
    );

    expect(screen.getByRole("link", { name: "Plan A" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Plan B" })).toBeTruthy();
  });
});

describe("ScoreComparisonTable — Avg. User Rating column", () => {
  test("shows LLM judge score without count when userRatingCount=0 (concurrence default)", () => {
    render(
      <ScoreComparisonTable
        rows={[
          makeRow({
            judgeScore: 0.75,
            avgUserRating: 0.75,
            userRatingCount: 0,
          }),
        ]}
      />
    );

    // Should show "75%" without parenthesized count
    expect(screen.getAllByText("75%")).toBeTruthy();
    expect(screen.queryByText(PARENTHESIZED_COUNT_REGEX)).toBeNull();
  });

  test("shows average and count when userRatingCount > 0", () => {
    render(
      <ScoreComparisonTable
        rows={[makeRow({ avgUserRating: 0.65, userRatingCount: 3 })]}
      />
    );

    expect(screen.getByText("65% (3)")).toBeTruthy();
  });

  test("Avg. User Rating cell contains no input element (read-only)", () => {
    render(<ScoreComparisonTable rows={[makeRow()]} />);

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });
});

describe("ScoreComparisonTable — Judge Score column", () => {
  test("displays judge score formatted to two decimal places", () => {
    render(<ScoreComparisonTable rows={[makeRow({ judgeScore: 0.9 })]} />);

    expect(screen.getByText("90%")).toBeTruthy();
  });
});

describe("ScoreComparisonTable — Delta column", () => {
  test("shows em dash for delta = 0", () => {
    render(<ScoreComparisonTable rows={[makeRow({ delta: 0 })]} />);

    expect(screen.getByText("—")).toBeTruthy();
  });

  test("shows formatted delta value when delta > 0", () => {
    render(
      <ScoreComparisonTable
        rows={[makeRow({ delta: 0.35, userRatingCount: 1 })]}
      />
    );

    expect(screen.getByText("35%")).toBeTruthy();
  });

  test("delta > 0.6 row has critical (red) style", () => {
    const { container } = render(
      <ScoreComparisonTable
        rows={[makeRow({ delta: 0.65, userRatingCount: 1 })]}
      />
    );

    // Find the delta cell by its text content
    const deltaCell = Array.from(container.querySelectorAll("td")).find((td) =>
      td.textContent?.includes("65%")
    );
    expect(deltaCell?.className).toContain("text-red-600");
  });

  test("delta > 0.3 (and ≤ 0.6) row has warning (amber) style", () => {
    const { container } = render(
      <ScoreComparisonTable
        rows={[makeRow({ delta: 0.4, userRatingCount: 1 })]}
      />
    );

    const deltaCell = Array.from(container.querySelectorAll("td")).find((td) =>
      td.textContent?.includes("40%")
    );
    expect(deltaCell?.className).toContain("text-amber-600");
  });

  test("delta = 0 row has no visual flag class", () => {
    const { container } = render(
      <ScoreComparisonTable rows={[makeRow({ delta: 0 })]} />
    );

    const deltaCell = Array.from(container.querySelectorAll("td")).find((td) =>
      td.textContent?.includes("—")
    );
    expect(deltaCell?.className).not.toContain("text-red-600");
    expect(deltaCell?.className).not.toContain("text-amber-600");
  });
});

describe("ScoreComparisonTable — table structure", () => {
  test("renders table inside scrollable container", () => {
    render(<ScoreComparisonTable rows={[makeRow()]} />);

    const container = screen.getByTestId("score-comparison-scroll-container");
    expect(container.className).toContain("overflow-y-auto");
  });

  test("renders table headers: Artifact, Judge Score, Avg. User Rating, Delta", () => {
    render(<ScoreComparisonTable rows={[makeRow()]} />);

    expect(screen.getByText("Artifact")).toBeTruthy();
    expect(screen.getByText("Judge Score")).toBeTruthy();
    expect(screen.getByText("Avg. User Rating")).toBeTruthy();
    expect(screen.getByText("Delta")).toBeTruthy();
  });

  test("renders one data row per item in rows", () => {
    render(
      <ScoreComparisonTable
        rows={[
          makeRow({
            judgeScoreId: "js-a1",
            artifactId: "a1",
            artifactTitle: "Plan A",
            artifactSlug: "plan-a",
          }),
          makeRow({
            judgeScoreId: "js-a2",
            artifactId: "a2",
            artifactTitle: "Plan B",
            artifactSlug: "plan-b",
          }),
          makeRow({
            judgeScoreId: "js-a3",
            artifactId: "a3",
            artifactTitle: "Plan C",
            artifactSlug: "plan-c",
          }),
        ]}
      />
    );

    expect(screen.getAllByRole("link")).toHaveLength(3);
  });
});
