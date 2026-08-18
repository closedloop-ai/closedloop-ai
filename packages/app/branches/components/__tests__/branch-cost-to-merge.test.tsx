import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeBranchDetail as detail } from "../../__tests__/branch-fixtures";
import { BranchCostToMerge } from "../branch-cost-to-merge";

const PERCENT_RE = /(\d+)%/;

describe("BranchCostToMerge", () => {
  it("renders the exact Build, Review, and Rework lifetime-cost contract", () => {
    render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: phaseCosts(6, 3, 1),
            totalCostUsd: complete(10),
          }),
          phaseAttribution: attribution(60_000, 30_000, 10_000),
        })}
      />
    );

    expect(screen.getByText("Cost breakdown")).toBeInTheDocument();
    expect(screen.getByText("$10.00")).toBeInTheDocument();
    expect(screen.getByText("Build")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("Rework")).toBeInTheDocument();
    expect(screen.getByText("1m 0s · $6.00 · 60%")).toBeInTheDocument();
    expect(screen.getByText("30.0s · $3.00 · 30%")).toBeInTheDocument();
    expect(screen.getByText("10.0s · $1.00 · 10%")).toBeInTheDocument();
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
    expect(screen.queryByText("Unattributed")).not.toBeInTheDocument();
  });

  it("keeps all three approved rows when a phase has zero cost", () => {
    render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: phaseCosts(2, 0, 1),
            totalCostUsd: complete(3),
          }),
          phaseAttribution: attribution(20_000, 0, 10_000),
        })}
      />
    );

    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("0ms · $0.00 · 0%")).toBeInTheDocument();
  });

  it("marks incomplete phase values and explains the qualifying-cost subtotal", () => {
    render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: {
              [BranchVisibleLifecyclePhase.Build]: partial(2),
              [BranchVisibleLifecyclePhase.Review]: partial(1),
              [BranchVisibleLifecyclePhase.Rework]: partial(0),
            },
            totalCostUsd: partial(3),
          }),
          phaseAttribution: attribution(20_000, 10_000, 0),
        })}
      />
    );

    expect(screen.getByText("$3.00*")).toBeInTheDocument();
    expect(screen.getByText("20.0s · $2.00* · 67%")).toBeInTheDocument();
    expect(
      screen.getByText("* Calculated from available qualifying Session costs.")
    ).toBeInTheDocument();
  });

  it("uses largest-remainder percentages so the rows reconcile to 100", () => {
    const { container } = render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: phaseCosts(1, 1, 1),
            totalCostUsd: complete(3),
          }),
          phaseAttribution: attribution(1, 1, 1),
        })}
      />
    );
    const percents = Array.from(
      container.querySelectorAll(".bq-costbd-val")
    ).map((node) => {
      const match = node.textContent?.match(PERCENT_RE);
      return match ? Number(match[1]) : Number.NaN;
    });

    expect(percents).toHaveLength(3);
    expect(percents.reduce((sum, percent) => sum + percent, 0)).toBe(100);
  });

  it("renders honest unavailable and zero-spend states", () => {
    const { rerender } = render(
      <BranchCostToMerge
        detail={detail({ canonicalMetrics: metricBundle() })}
      />
    );
    expect(
      screen.getByText(
        "Build, Review, and Rework cost evidence is unavailable."
      )
    ).toBeInTheDocument();

    rerender(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: phaseCosts(0, 0, 0),
            totalCostUsd: complete(0),
          }),
          phaseAttribution: attribution(0, 0, 0),
        })}
      />
    );
    expect(
      screen.getByText("No priced spend recorded yet.")
    ).toBeInTheDocument();
  });

  it("marks the segmented bar decorative because rows carry the values", () => {
    const { container } = render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: phaseCosts(1, 1, 0),
            totalCostUsd: complete(2),
          }),
          phaseAttribution: attribution(1, 1, 0),
        })}
      />
    );
    expect(container.querySelector(".bq-cost-bar")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
  });
});

function metricBundle(
  overrides: Partial<{
    phaseCostUsd: Record<
      BranchVisibleLifecyclePhase,
      BranchMetricResult<number>
    >;
    totalCostUsd: BranchMetricResult<number>;
  }> = {}
) {
  const unavailable = unavailableMetric();
  return {
    abandonmentTimeMs: unavailable,
    idleTimeMs: unavailable,
    leadTimeMs: unavailable,
    locPerDollar: unavailable,
    phaseCostUsd: {
      [BranchVisibleLifecyclePhase.Build]: unavailable,
      [BranchVisibleLifecyclePhase.Review]: unavailable,
      [BranchVisibleLifecyclePhase.Rework]: unavailable,
    },
    totalCostUsd: unavailable,
    ...overrides,
  };
}

function phaseCosts(build: number, review: number, rework: number) {
  return {
    [BranchVisibleLifecyclePhase.Build]: complete(build),
    [BranchVisibleLifecyclePhase.Review]: complete(review),
    [BranchVisibleLifecyclePhase.Rework]: complete(rework),
  };
}

function attribution(
  buildDurationMs: number,
  reviewDurationMs: number,
  reworkDurationMs: number
): BranchPhaseAttributionResult {
  const durations = {
    [BranchVisibleLifecyclePhase.Build]: buildDurationMs,
    [BranchVisibleLifecyclePhase.Review]: reviewDurationMs,
    [BranchVisibleLifecyclePhase.Rework]: reworkDurationMs,
  };
  return {
    segments: [],
    rollups: Object.values(BranchVisibleLifecyclePhase).map((phase) => ({
      phase,
      estimatedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: durations[phase],
      sessionCount: 1,
    })),
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 0,
    },
  };
}

function complete(value: number): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Complete, value };
}

function partial(value: number): BranchMetricResult<number> {
  return {
    state: BranchMetricAvailability.Partial,
    value,
    disclosure: BranchMetricDisclosure.CostIncomplete,
  };
}

function unavailableMetric(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Unavailable, value: null };
}
