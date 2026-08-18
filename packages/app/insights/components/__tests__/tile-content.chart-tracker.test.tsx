import type {
  DeliveryInsightsResponse,
  TimeSeries,
} from "@repo/api/src/types/insights";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import type { CategoryDatum } from "@repo/design-system/components/ui/category-bar-chart";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type TileDescriptor, TileKind } from "../../lib/tile-catalog";
import { InsightsChartContent } from "../tile-content";

const HEATMAP_CELL_PREFIX_REGEX = /^heatmap-cell-/;

vi.mock("@repo/design-system/components/ui/category-bar-chart", () => ({
  CategoryBarChart: ({
    data,
    onDatumClick,
    selectedKey,
  }: {
    data: CategoryDatum[];
    onDatumClick?: (datum: CategoryDatum) => void;
    selectedKey?: string | null;
  }) => (
    <div data-testid="mock-category-bar-chart">
      {selectedKey ? <div data-testid="tracker-line">{selectedKey}</div> : null}
      {data.map((datum) => (
        <button
          data-value={String(datum.value)}
          key={datum.key}
          onClick={() => onDatumClick?.(datum)}
          type="button"
        >
          {`Click ${datum.label} ${datum.key}`}
        </button>
      ))}
    </div>
  ),
}));

vi.mock(
  "@repo/design-system/components/ui/primitives/activity-heatmap",
  () => ({
    ActivityHeatmap: ({
      weeks,
    }: {
      weeks: Array<Array<{ date: string; count: number }>>;
      valueFormatter?: (count: number) => string;
    }) => (
      <div data-testid="mock-activity-heatmap">
        {weeks.map((week, wi) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: index is the semantic week position
          <div data-testid={`heatmap-week-${wi}`} key={wi}>
            {week.map((cell, di) => (
              <span
                data-count={String(cell.count)}
                data-day={String(di)}
                data-testid={`heatmap-cell-${cell.date}`}
                key={cell.date}
              >
                {cell.date}
              </span>
            ))}
          </div>
        ))}
      </div>
    ),
  })
);

vi.mock("@repo/design-system/components/ui/time-series-area-chart", () => ({
  TimeSeriesAreaChart: ({
    series,
  }: {
    series: Array<{ key: string; label: string }>;
  }) => (
    <div data-testid="mock-time-series-area-chart">
      {series.map((s) => (
        <span data-testid={`series-label-${s.key}`} key={s.key}>
          {s.label}
        </span>
      ))}
    </div>
  ),
}));

const timeSeriesBarTile: TileDescriptor = {
  id: "chart:prTrend:bar",
  section: InsightsSection.Delivery,
  title: "PR throughput by day",
  kind: TileKind.TimeSeriesBar,
  dataKey: "prTrend",
  metricKey: "merged",
  metricLabel: "Pull requests",
  groupBy: { key: "date", label: "Date" },
  grid: { w: 12, h: 4 },
};

const klocTrendBarTile: TileDescriptor = {
  ...timeSeriesBarTile,
  id: "chart:klocTrend:bar",
  title: "KLOC merged by day",
  dataKey: "klocTrend",
  metricKey: "kloc",
};

const prTrendTile: TileDescriptor = {
  id: "chart:prTrend",
  section: InsightsSection.Delivery,
  title: "PR throughput",
  kind: TileKind.TimeSeries,
  dataKey: "prTrend",
  metricKey: "merged",
  metricLabel: "Pull requests",
  groupBy: { key: "date", label: "Date" },
  grid: { w: 12, h: 4 },
};

const heatmapTile: TileDescriptor = {
  id: "chart:prTrend:heatmap",
  section: InsightsSection.Delivery,
  title: "PR activity heatmap",
  kind: TileKind.Heatmap,
  dataKey: "prTrend",
  metricKey: "merged",
  metricLabel: "Pull requests",
  grid: { w: 12, h: 4 },
};

describe("InsightsChartContent time-series bar tracker", () => {
  it("maps repeated clicked datum keys to each source point date", () => {
    render(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeTimeSeries([
              ["2026-01-01", 5],
              ["2027-01-01", 8],
            ])
          ),
        }}
        tile={timeSeriesBarTile}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Click 01/01 2026-01-01" })
    );
    expect(screen.getByTestId("tracker-line")).toHaveTextContent("2026-01-01");

    fireEvent.click(
      screen.getByRole("button", { name: "Click 01/01 2027-01-01" })
    );

    expect(screen.getByTestId("tracker-line")).toHaveTextContent("2027-01-01");
    expect(screen.getByTestId("tracker-line")).not.toHaveTextContent("01/01");
  });

  it("clears the selected tracker when the current time range omits the prior key", () => {
    const { rerender } = render(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeTimeSeries([
              ["2026-01-01", 5],
              ["2026-01-02", 8],
            ])
          ),
        }}
        tile={timeSeriesBarTile}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Click 01/01 2026-01-01" })
    );
    expect(screen.getByTestId("tracker-line")).toHaveTextContent("2026-01-01");

    rerender(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeTimeSeries([
              ["2026-02-01", 3],
              ["2026-02-02", 6],
            ])
          ),
        }}
        tile={timeSeriesBarTile}
      />
    );

    expect(screen.queryByTestId("tracker-line")).not.toBeInTheDocument();
  });

  it("clears the selected tracker when the chart data changes but keeps an overlapping key", () => {
    const { rerender } = render(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeTimeSeries([
              ["2026-01-01", 5],
              ["2026-01-02", 8],
            ])
          ),
        }}
        tile={timeSeriesBarTile}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Click 01/01 2026-01-01" })
    );
    expect(screen.getByTestId("tracker-line")).toHaveTextContent("2026-01-01");

    rerender(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeTimeSeries([
              ["2026-01-01", 13],
              ["2026-02-01", 6],
            ])
          ),
        }}
        tile={timeSeriesBarTile}
      />
    );

    expect(screen.queryByTestId("tracker-line")).not.toBeInTheDocument();
  });

  it("does not carry the selected tracker across different bar tiles with the same bucket key", () => {
    const { rerender } = render(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeTimeSeries([
              ["2026-01-01", 5],
              ["2026-01-02", 8],
            ]),
            makeTimeSeries([
              ["2026-01-01", 2],
              ["2026-01-02", 4],
            ])
          ),
        }}
        tile={timeSeriesBarTile}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Click 01/01 2026-01-01" })
    );
    expect(screen.getByTestId("tracker-line")).toHaveTextContent("2026-01-01");

    rerender(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeTimeSeries([
              ["2026-01-01", 5],
              ["2026-01-02", 8],
            ]),
            makeTimeSeries([
              ["2026-01-01", 2],
              ["2026-01-02", 4],
            ])
          ),
        }}
        tile={klocTrendBarTile}
      />
    );

    expect(screen.queryByTestId("tracker-line")).not.toBeInTheDocument();
  });

  it("keeps the existing empty state for empty or all-zero time-series data", () => {
    const { rerender } = render(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(makeTimeSeries([])),
        }}
        tile={timeSeriesBarTile}
      />
    );

    expect(screen.getByText("No data yet")).toBeInTheDocument();
    expect(
      screen.queryByTestId("mock-category-bar-chart")
    ).not.toBeInTheDocument();

    rerender(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeTimeSeries([["2026-01-01", 0]])
          ),
        }}
        tile={timeSeriesBarTile}
      />
    );

    expect(screen.getByText("No data yet")).toBeInTheDocument();
    expect(
      screen.queryByTestId("mock-category-bar-chart")
    ).not.toBeInTheDocument();
  });
});

describe("InsightsChartContent two-series prTrend", () => {
  it("passes both series labels through to the time-series chart", () => {
    render(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeSplitTimeSeries([["2026-01-01", 3, 2]])
          ),
        }}
        tile={prTrendTile}
      />
    );

    expect(screen.getByText("Agent-raised")).toBeInTheDocument();
    expect(screen.getByText("Manual/untracked")).toBeInTheDocument();
  });

  it("bar variant sums only declared series keys when computing bucket values", () => {
    render(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeSplitTimeSeries([["2026-01-01", 2, 1]])
          ),
        }}
        tile={timeSeriesBarTile}
      />
    );

    // timeSeriesToBuckets reduces over chart.series [{agent}, {manual}],
    // so the bucket value is 2+1=3, not 3+3=6 (which would happen if the
    // undeclared merged key were also summed).
    const button = screen.getByRole("button", {
      name: "Click 01/01 2026-01-01",
    });
    expect(button).toHaveAttribute("data-value", "3");
  });

  it("shows the empty state when all two-series values are zero", () => {
    render(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeSplitTimeSeries([["2026-01-01", 0, 0]])
          ),
        }}
        tile={prTrendTile}
      />
    );

    expect(screen.getByText("No data yet")).toBeInTheDocument();
    expect(
      screen.queryByTestId("mock-time-series-area-chart")
    ).not.toBeInTheDocument();
  });
});

function makeSplitTimeSeries(points: [string, number, number][]): TimeSeries {
  return {
    series: [
      { key: "agent", label: "Agent-raised" },
      { key: "manual", label: "Manual/untracked" },
    ],
    points: points.map(([date, agent, manual]) => ({
      date,
      values: { agent, manual, merged: agent + manual },
    })),
  };
}

function makeTimeSeries(points: [string, number][]): TimeSeries {
  return {
    series: [{ key: "merged", label: "Merged" }],
    points: points.map(([date, value]) => ({
      date,
      values: { merged: value },
    })),
  };
}

// timeSeriesToHeatmapWeeks placement tests (FEA-2650)
// The function is private; we test through the rendered ActivityHeatmap mock.
// UTC-noon padding in the implementation makes cell placement TZ-stable across
// all environments without needing to pin process.env.TZ here.
describe("timeSeriesToHeatmapWeeks placement (FEA-2650)", () => {
  it("pads leading cells when the series starts mid-week", () => {
    // 2026-01-07 is a Wednesday (UTCDay=3). The week boundary snaps back to
    // Sunday 2026-01-04, producing 3 leading zero-count cells (Sun/Mon/Tue).
    render(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeTimeSeries([["2026-01-07", 42]])
          ),
        }}
        tile={heatmapTile}
      />
    );

    const week0 = screen.getByTestId("heatmap-week-0");
    // Sun/Mon/Tue precede the Wednesday data cell — all zero-filled padding.
    expect(
      within(week0).getByTestId("heatmap-cell-2026-01-04")
    ).toHaveAttribute("data-count", "0");
    expect(
      within(week0).getByTestId("heatmap-cell-2026-01-05")
    ).toHaveAttribute("data-count", "0");
    expect(
      within(week0).getByTestId("heatmap-cell-2026-01-06")
    ).toHaveAttribute("data-count", "0");
    expect(
      within(week0).getByTestId("heatmap-cell-2026-01-07")
    ).toHaveAttribute("data-count", "42");

    // The algorithm never emits partial weeks; total cell count is always a
    // multiple of 7.
    const allCells = screen.getAllByTestId(HEATMAP_CELL_PREFIX_REGEX);
    expect(allCells.length % 7).toBe(0);
  });

  it("pads trailing cells when the series ends mid-week", () => {
    // 2026-01-07 (Wed, UTCDay=3) start, 2026-01-14 (Wed, UTCDay=3) end.
    // The last week is expanded to Saturday 2026-01-17; Thu/Fri/Sat are
    // trailing zero-count cells.
    render(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeTimeSeries([
              ["2026-01-07", 5],
              ["2026-01-14", 8],
            ])
          ),
        }}
        tile={heatmapTile}
      />
    );

    // Week 1 spans Sun 2026-01-11 → Sat 2026-01-17.
    const week1 = screen.getByTestId("heatmap-week-1");
    expect(
      within(week1).getByTestId("heatmap-cell-2026-01-14")
    ).toHaveAttribute("data-count", "8");
    // Thu/Fri/Sat after the Wednesday value are trailing padding.
    expect(
      within(week1).getByTestId("heatmap-cell-2026-01-15")
    ).toHaveAttribute("data-count", "0");
    expect(
      within(week1).getByTestId("heatmap-cell-2026-01-16")
    ).toHaveAttribute("data-count", "0");
    expect(
      within(week1).getByTestId("heatmap-cell-2026-01-17")
    ).toHaveAttribute("data-count", "0");

    const allCells = screen.getAllByTestId(HEATMAP_CELL_PREFIX_REGEX);
    expect(allCells.length % 7).toBe(0);
  });

  it("places a Sunday at day-index 0 and a Saturday at day-index 6", () => {
    // 2026-01-03 is Saturday (UTCDay=6); 2026-01-04 is Sunday (UTCDay=0).
    // Cursor backs up from Saturday to the preceding Sunday 2025-12-28,
    // placing 2026-01-03 at the last slot (di=6) of week 0.
    // 2026-01-04 opens week 1 at slot di=0.
    render(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeTimeSeries([
              ["2026-01-03", 5],
              ["2026-01-04", 7],
            ])
          ),
        }}
        tile={heatmapTile}
      />
    );

    expect(screen.getByTestId("heatmap-cell-2026-01-03")).toHaveAttribute(
      "data-day",
      "6"
    );
    expect(screen.getByTestId("heatmap-cell-2026-01-04")).toHaveAttribute(
      "data-day",
      "0"
    );
  });

  it("places distinct values in their correct (week, day) cells", () => {
    // 2026-01-04 (Sun, UTCDay=0), 2026-01-07 (Wed, UTCDay=3), 2026-01-10
    // (Sat, UTCDay=6). All three fall in the same week with no leading or
    // trailing padding (series starts on Sunday, ends on Saturday).
    render(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse(
            makeTimeSeries([
              ["2026-01-04", 7],
              ["2026-01-07", 3],
              ["2026-01-10", 5],
            ])
          ),
        }}
        tile={heatmapTile}
      />
    );

    expect(screen.getByTestId("heatmap-cell-2026-01-04")).toHaveAttribute(
      "data-count",
      "7"
    );
    expect(screen.getByTestId("heatmap-cell-2026-01-07")).toHaveAttribute(
      "data-count",
      "3"
    );
    expect(screen.getByTestId("heatmap-cell-2026-01-10")).toHaveAttribute(
      "data-count",
      "5"
    );
    // Days not supplied are zero-filled, not absent.
    expect(screen.getByTestId("heatmap-cell-2026-01-05")).toHaveAttribute(
      "data-count",
      "0"
    );
  });
});

function makeDeliveryResponse(
  prTrend: TimeSeries,
  klocTrend?: TimeSeries
): DeliveryInsightsResponse {
  return {
    kpis: [
      {
        key: "merged",
        label: "Merged PRs",
        value: 0,
        format: KpiFormat.Number,
        sub: "pull requests",
        deltaPct: null,
      },
    ],
    charts: {
      prTrend,
      klocTrend,
      prByRepo: [],
      meanTimeToMerge: [],
      prByState: [],
      branchLifespan: [],
      branchesWithoutPr: [],
    },
  };
}
