import {
  LossClass,
  type LostWorkTrendPoint,
} from "@repo/api/src/types/session-analytics";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LossTrend, TREND_UNAVAILABLE_REASON } from "../components/loss-trend";

/**
 * The trend widget's state machine (ISS-4987). Raised in review (comment
 * 3711680930): nothing rendered its three branches, and the risk is the one the
 * component's own docstring names — an unavailable trend degrading to a flat or
 * empty chart reads as "a good week" rather than "we did not load it".
 *
 * The chart primitive is stubbed so these assertions are about THIS component's
 * branching and the data it hands down, not about Recharts' rendering (which
 * does not lay out in jsdom anyway). `time-series-area-chart.stories.tsx`
 * covers the primitive.
 */

const CHART_TESTID = "time-series-area-chart";

vi.mock("@repo/design-system/components/ui/time-series-area-chart", () => ({
  TimeSeriesAreaChart: ({
    points,
    emptyMessage,
  }: {
    points: { date: string; values: Record<string, number> }[];
    emptyMessage?: string;
  }) => (
    <div
      data-empty-message={emptyMessage}
      data-point-count={points.length}
      data-testid={CHART_TESTID}
    >
      {points.map((point) => (
        <span key={point.date}>
          {point.date}:{point.values[LossClass.Systemic]}
        </span>
      ))}
    </div>
  ),
}));

function point(
  date: string,
  overrides: Partial<Record<LossClass, number>> = {}
): LostWorkTrendPoint {
  return {
    date,
    values: {
      [LossClass.Actionable]: 0,
      [LossClass.Systemic]: 0,
      [LossClass.Unattributed]: 0,
      ...overrides,
    },
  };
}

describe("the lost wall-clock trend", () => {
  it("reserves the chart's height while loading rather than collapsing", () => {
    render(<LossTrend loading={true} trend={null} />);

    // Neither of the settled answers may appear while the read is in flight.
    expect(screen.queryByText(TREND_UNAVAILABLE_REASON)).toBeNull();
    expect(screen.queryByTestId(CHART_TESTID)).toBeNull();
  });

  it("says the trend did not load instead of drawing a flat chart", () => {
    render(<LossTrend loading={false} trend={null} />);

    // The defect this branch exists to prevent: a failed read rendering an
    // empty chart, which on this screen reads as "a good week".
    expect(screen.getByText(TREND_UNAVAILABLE_REASON)).toBeInTheDocument();
    expect(screen.queryByTestId(CHART_TESTID)).toBeNull();
  });

  it("draws the chart with its own empty copy for a genuinely quiet range", () => {
    render(<LossTrend loading={false} trend={[]} />);

    // An empty ARRAY is a measurement (no sessions), not a failure — so the
    // chart renders and speaks for itself rather than borrowing the
    // unavailable reason.
    const chart = screen.getByTestId(CHART_TESTID);
    expect(chart).toHaveAttribute(
      "data-empty-message",
      "No sessions in this range."
    );
    expect(screen.queryByText(TREND_UNAVAILABLE_REASON)).toBeNull();
  });

  it("passes every day through, including the zero-filled quiet ones", () => {
    // The server enumerates the whole window and zero-fills days with no
    // sessions, so a gap cannot be drawn as a ramp between distant points. The
    // render must not filter those back out.
    const trend = [
      point("2026-07-20", { [LossClass.Systemic]: 4 }),
      point("2026-07-21"),
      point("2026-07-22"),
      point("2026-07-23", { [LossClass.Systemic]: 9 }),
    ];

    render(<LossTrend loading={false} trend={trend} />);

    const chart = screen.getByTestId(CHART_TESTID);
    expect(chart).toHaveAttribute("data-point-count", "4");
    expect(screen.getByText("2026-07-21:0")).toBeInTheDocument();
    // The systemic spike survives intact and unrounded.
    expect(screen.getByText("2026-07-23:9")).toBeInTheDocument();
  });

  it("hands the series down unrounded", () => {
    // Rounding each of 30 daily buckets let the drift accumulate until the
    // charted series no longer summed to the headline it is split from;
    // display rounding belongs in the chart's value formatter.
    render(
      <LossTrend
        loading={false}
        trend={[point("2026-07-20", { [LossClass.Systemic]: 2.45 })]}
      />
    );

    expect(screen.getByText("2026-07-20:2.45")).toBeInTheDocument();
  });
});
