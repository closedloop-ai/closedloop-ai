/**
 * JudgeAnalyticsChart hosts its box-plot rendering through a custom Recharts
 * `Bar` `shape` render-prop and a custom Tooltip `content`. Recharts itself is
 * mocked (matching the established pattern in
 * packages/app/insights/components/__tests__/category-bar-chart.*.test.tsx):
 * `BarChart` forwards its `data` down to children as `__chartData`, `Bar`
 * calls the real `shape` function once per data point with synthetic
 * geometry (so the real, unmocked `BoxPlotShape`/`renderCandlestick`/
 * `computeBoxBounds` logic in the source file actually runs and paints real
 * SVG), and `Tooltip` renders its `content` element against the first data
 * point (so the real, unmocked `BoxPlotTooltip` logic runs) without needing
 * to simulate a real Recharts mouse-hover interaction.
 */

import type { JudgeAggregateStats } from "@repo/api/src/types/judges-analytics";
import { render, screen } from "@testing-library/react";
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { describe, expect, it, vi } from "vitest";
import { JudgeAnalyticsChart } from "../judge-analytics-chart";

const EVAL_COLOR = "var(--info)";
const HUMAN_COLOR = "var(--warning)";

type ChartDataChild = ReactElement<{ __chartData?: unknown[] }>;

vi.mock("recharts", () => ({
  BarChart: ({ children, data }: { children: ReactNode; data: unknown[] }) => (
    <div data-testid="bar-chart">
      {Children.map(children, (child) =>
        isValidElement(child)
          ? cloneElement(child as ChartDataChild, { __chartData: data })
          : child
      )}
    </div>
  ),
  Bar: ({
    shape,
    __chartData = [],
  }: {
    shape: (props: {
      x: number;
      y: number;
      width: number;
      height: number;
      payload: unknown;
    }) => ReactNode;
    __chartData?: Array<{ name: string }>;
  }) => (
    <svg aria-label="Bar chart bars" data-testid="bars" role="img">
      {__chartData.map((payload, index) => (
        <g data-judge={payload.name} key={payload.name}>
          {shape({ x: index * 100, y: 0, width: 80, height: 200, payload })}
        </g>
      ))}
    </svg>
  ),
  XAxis: () => null,
  YAxis: () => null,
  Legend: () => null,
  Tooltip: ({
    content,
    __chartData = [],
  }: {
    content?: ReactElement<{ active?: boolean; payload?: unknown }>;
    __chartData?: unknown[];
  }) => {
    const point = __chartData[0];
    if (!(content && point)) {
      return null;
    }
    return cloneElement(content, {
      active: true,
      payload: [{ payload: point }],
    });
  },
  ResponsiveContainer: ({ children }: { children: ReactNode }) => children,
}));

function judge(overrides: Partial<JudgeAggregateStats>): JudgeAggregateStats {
  return {
    judgeName: "Judge",
    promptName: "judge-v1",
    metricName: "metric",
    documentsEvaluated: 10,
    min: 0.2,
    mean: 0.5,
    max: 0.9,
    stdDev: 0.1,
    humanMin: null,
    humanMax: null,
    humanMean: null,
    humanStdDev: null,
    ...overrides,
  };
}

// No human ratings at all. eval bounds: lowerBox=max(0.4,0.2)=0.4, upperBox=min(0.6,0.9)=0.6.
const JUDGE_NO_HUMAN = judge({ judgeName: "Clarity" });

// Full human stats, chosen so no eval percentage collides with a human one.
// eval: mean 0.5, stdDev 0.1, min 0.1, max 0.9 -> box [0.4, 0.6].
// human: mean 0.7, stdDev 0.05, min 0.55, max 0.85 -> box [0.65, 0.75].
const JUDGE_WITH_HUMAN = judge({
  judgeName: "Helpfulness",
  min: 0.1,
  mean: 0.5,
  max: 0.9,
  stdDev: 0.1,
  humanMin: 0.55,
  humanMax: 0.85,
  humanMean: 0.7,
  humanStdDev: 0.05,
});

// Human fields partially present (stdDev missing) — the top-level hasHuman
// gate is false, so humanLowerBox/humanUpperBox land as null even though
// humanMean/humanMin/humanMax are set. BoxPlotShape requires ALL FIVE human
// fields before it draws a human candlestick, so this judge's human side
// must stay suppressed.
const JUDGE_PARTIAL_HUMAN = judge({
  judgeName: "Partial",
  min: 0.3,
  mean: 0.6,
  max: 0.9,
  stdDev: 0.1,
  humanMin: 0.4,
  humanMax: 0.9,
  humanMean: 0.6,
  humanStdDev: null,
});

// Zero-width eval range (min === mean === max) — renderCandlestick's
// dataRange === 0 branch draws a single median line instead of a box.
const JUDGE_ZERO_RANGE = judge({
  judgeName: "Consistency",
  min: 0.5,
  mean: 0.5,
  max: 0.5,
  stdDev: 0,
});

describe("JudgeAnalyticsChart — candlestick rendering", () => {
  it("renders one eval candlestick (box + whiskers) per judge", () => {
    const { container } = render(
      <JudgeAnalyticsChart data={[JUDGE_NO_HUMAN]} documentType="PRD" />
    );

    expect(
      container.querySelectorAll(`rect[fill="${EVAL_COLOR}"]`)
    ).toHaveLength(1);
    // whisker-to-box, lower cap, median, box-to-whisker, upper cap.
    expect(
      container.querySelectorAll(`line[stroke="${EVAL_COLOR}"]`)
    ).toHaveLength(5);
  });

  it("draws a human candlestick only when every human stat is present", () => {
    const { container } = render(
      <JudgeAnalyticsChart
        data={[JUDGE_WITH_HUMAN, JUDGE_PARTIAL_HUMAN]}
        documentType="PRD"
      />
    );

    // Both judges have a non-zero eval range, so both get an eval box.
    expect(
      container.querySelectorAll(`rect[fill="${EVAL_COLOR}"]`)
    ).toHaveLength(2);
    // Only JUDGE_WITH_HUMAN has all five human fields non-null.
    expect(
      container.querySelectorAll(`rect[fill="${HUMAN_COLOR}"]`)
    ).toHaveLength(1);
    expect(
      container.querySelectorAll(`line[stroke="${HUMAN_COLOR}"]`)
    ).toHaveLength(5);
  });

  it("collapses to a single median line when the eval range has zero width", () => {
    const { container } = render(
      <JudgeAnalyticsChart data={[JUDGE_ZERO_RANGE]} documentType="PRD" />
    );

    expect(container.querySelectorAll("rect")).toHaveLength(0);
    expect(
      container.querySelectorAll(`line[stroke="${EVAL_COLOR}"]`)
    ).toHaveLength(1);
  });

  it("renders no candlesticks for an empty data set", () => {
    const { container } = render(
      <JudgeAnalyticsChart data={[]} documentType="PRD" />
    );

    expect(container.querySelectorAll("rect")).toHaveLength(0);
    expect(container.querySelectorAll("line")).toHaveLength(0);
  });
});

describe("JudgeAnalyticsChart — tooltip", () => {
  it("shows only the Eval section when the judge has no human ratings", () => {
    render(<JudgeAnalyticsChart data={[JUDGE_NO_HUMAN]} documentType="PRD" />);

    expect(screen.getByText("Eval")).toBeInTheDocument();
    expect(screen.queryByText("Human")).not.toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument(); // Max (judge.max)
    expect(screen.getByText("60%")).toBeInTheDocument(); // Mean + 1σ
    expect(screen.getByText("50%")).toBeInTheDocument(); // Mean
    expect(screen.getByText("40%")).toBeInTheDocument(); // Mean - 1σ
    expect(screen.getByText("20%")).toBeInTheDocument(); // Min (judge.min)
  });

  it("shows both Eval and Human sections when the judge has full human ratings", () => {
    render(
      <JudgeAnalyticsChart data={[JUDGE_WITH_HUMAN]} documentType="PRD" />
    );

    expect(screen.getByText("Eval")).toBeInTheDocument();
    expect(screen.getByText("Human")).toBeInTheDocument();
    // Eval: max 0.9, box [0.4, 0.6], mean 0.5, min 0.1.
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
    // Human: max 0.85, box [0.65, 0.75], mean 0.7, min 0.55.
    expect(screen.getByText("85%")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
    expect(screen.getByText("65%")).toBeInTheDocument();
    expect(screen.getByText("55%")).toBeInTheDocument();
  });
});
