import type {
  AgentsInsightsResponse,
  CategoryBucket,
  DeliveryInsightsResponse,
  KpiStat,
  TimeSeries,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import { SPEND_OUTCOME_ZERO_MESSAGE } from "@repo/app/insights/lib/spend-outcome-palette";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import type { CategoryDatum } from "@repo/design-system/components/ui/category-bar-chart";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  type ChartTileDescriptor,
  getTile,
  type TileDescriptor,
  TileKind,
} from "../../lib/tile-catalog";
import {
  UsageGrouping,
  usageOtherSeriesLabel,
} from "../overview/usage-graph-toggles";
import {
  DELIVERY_SEGMENT_FEATURE_FLAG_KEY,
  InsightsChartContent,
  type InsightsSectionData,
  selectKpi,
} from "../tile-content";

vi.mock("@repo/design-system/components/ui/category-bar-chart", () => ({
  CategoryBarChart: ({
    data,
    allowDecimals,
    onDatumClick,
    selectedKey,
  }: {
    data: CategoryDatum[];
    allowDecimals?: boolean;
    onDatumClick?: (datum: CategoryDatum) => void;
    selectedKey?: string | null;
  }) => (
    <div
      data-allow-decimals={String(allowDecimals)}
      data-selected={selectedKey ?? "none"}
      data-testid="mock-bar-chart"
    >
      {data.map((datum) => (
        <button
          key={datum.key}
          onClick={() => onDatumClick?.(datum)}
          type="button"
        >{`${datum.label}=${datum.value}`}</button>
      ))}
    </div>
  ),
}));

vi.mock("@repo/design-system/components/ui/donut-chart", () => ({
  DonutChart: ({
    data,
    otherSeriesLabel,
  }: {
    data: CategoryDatum[];
    otherSeriesLabel?: string;
  }) => (
    <div data-other={otherSeriesLabel} data-testid="mock-donut-chart">
      {data.map((datum) => (
        <span key={datum.key}>{`${datum.label}=${datum.value}`}</span>
      ))}
    </div>
  ),
}));

vi.mock("@repo/design-system/components/ui/time-series-area-chart", () => ({
  TimeSeriesAreaChart: ({
    series,
    otherSeriesLabel,
    comparison,
    comparisonLabel,
    allowDecimals,
  }: {
    series: Array<{ key: string; label: string }>;
    otherSeriesLabel?: string;
    comparison?: TimeSeries;
    comparisonLabel?: string;
    allowDecimals?: boolean;
  }) => (
    <div
      data-allow-decimals={String(allowDecimals)}
      data-comparison-label={comparisonLabel ?? "none"}
      data-comparison-points={
        comparison ? String(comparison.points.length) : "none"
      }
      data-other={otherSeriesLabel}
      data-testid="mock-area-chart"
    >
      {series.map((entry) => (
        <span key={entry.key}>{entry.label}</span>
      ))}
    </div>
  ),
}));

vi.mock(
  "@repo/design-system/components/ui/primitives/activity-heatmap",
  () => ({
    ActivityHeatmap: ({
      label,
      weeks,
    }: {
      label: string;
      weeks: Array<Array<{ date: string; count: number }>>;
    }) => (
      <div
        data-label={label}
        data-testid="mock-heatmap"
        data-weeks={String(weeks.length)}
      >
        {weeks
          .flat()
          .filter((cell) => cell.count > 0)
          .map((cell) => (
            <span key={cell.date}>{`${cell.date}:${cell.count}`}</span>
          ))}
      </div>
    ),
  })
);

const NO_DATA = "No data yet";
const SEGMENT_PROMPT =
  "Select a repository to drill into its delivery segment.";
const GENERIC_OTHER_SERIES = "Other series";
const SERIES_KEY = "value";

const TIME_SERIES_DATES: Record<string, string> = {
  prTrend: "2026-01-05",
  klocTrend: "2026-01-12",
  eventActivity: "2026-02-02",
  eventVolume: "2026-02-09",
  modelUsageOverTime: "2026-03-02",
  toolRunsOverTime: "2026-03-09",
};

const TIME_SERIES_VALUES: Record<string, number> = {
  prTrend: 3,
  klocTrend: 5,
  eventActivity: 7,
  eventVolume: 11,
  modelUsageOverTime: 13,
  toolRunsOverTime: 17,
};

const TIME_SERIES_TILE_IDS = [
  "chart:prTrend",
  "chart:prTrend:bar",
  "chart:prTrend:heatmap",
  "chart:klocTrend",
  "chart:klocTrend:bar",
  "chart:klocTrend:heatmap",
  "chart:eventActivity",
  "chart:eventActivity:bar",
  "chart:eventActivity:heatmap",
  "chart:eventVolume",
  "chart:eventVolume:bar",
  "chart:eventVolume:heatmap",
  "chart:modelUsageOverTime",
  "chart:modelUsageOverTime:bar",
  "chart:modelUsageOverTime:heatmap",
  "chart:toolRunsOverTime",
  "chart:toolRunsOverTime:bar",
  "chart:toolRunsOverTime:heatmap",
];

const CATEGORY_TILE_IDS = [
  "chart:prByRepo:donut",
  "chart:prByState",
  "chart:prByState:donut",
  "chart:checkStatus",
  "chart:checkStatus:bar",
  "chart:branchesWithoutPr",
  "chart:branchLifespan:donut",
  "chart:meanTimeToMerge",
  "chart:eventsByType",
  "chart:eventsByType:bar",
  "chart:userBreakdown",
  "chart:reviewQueue:donut",
  "chart:modelBreakdown",
  "chart:tokenDistribution",
  "chart:toolUsage",
  "chart:agentsByStatus:bar",
  "chart:agentsByType:donut",
  "chart:spendByOutcome",
];

const SECTIONS_UNDER_TEST = [
  InsightsSection.Delivery,
  InsightsSection.Utilization,
  InsightsSection.Agents,
];

describe("InsightsChartContent data-key dispatch", () => {
  it.each(TIME_SERIES_TILE_IDS)(
    "renders %s from its own time series",
    (tileId) => {
      const tile = requireTile(tileId);
      renderContent(tile, fullSections());

      const date = TIME_SERIES_DATES[tile.dataKey];
      const value = TIME_SERIES_VALUES[tile.dataKey];
      if (tile.kind === TileKind.TimeSeries) {
        expect(
          within(screen.getByTestId("mock-area-chart")).getByText(
            `${tile.dataKey} series`
          )
        ).toBeInTheDocument();
      } else if (tile.kind === TileKind.TimeSeriesBar) {
        const [, month, day] = date.split("-");
        expect(
          within(screen.getByTestId("mock-bar-chart")).getByText(
            `${month}/${day}=${value}`
          )
        ).toBeInTheDocument();
      } else {
        expect(
          within(screen.getByTestId("mock-heatmap")).getByText(
            `${date}:${value}`
          )
        ).toBeInTheDocument();
      }
    }
  );

  it.each(CATEGORY_TILE_IDS)(
    "renders %s from its own category buckets",
    (tileId) => {
      const tile = requireTile(tileId);
      renderContent(tile, fullSections());

      const testId =
        tile.kind === TileKind.Donut ? "mock-donut-chart" : "mock-bar-chart";
      expect(
        within(screen.getByTestId(testId)).getByText(`${tile.dataKey} bucket=4`)
      ).toBeInTheDocument();
    }
  );

  it.each(SECTIONS_UNDER_TEST)(
    "shows the empty state for an unknown %s category or time-series key",
    (section) => {
      const categoryTile = customTile({
        section,
        kind: TileKind.CategoryBar,
        dataKey: "unknownKey",
      });
      const { unmount } = renderContent(categoryTile, fullSections());
      expect(screen.getByText(NO_DATA)).toBeInTheDocument();
      expect(screen.queryByTestId("mock-bar-chart")).not.toBeInTheDocument();
      unmount();

      const seriesTile = customTile({
        section,
        kind: TileKind.TimeSeries,
        dataKey: "unknownKey",
      });
      renderContent(seriesTile, fullSections());
      expect(screen.getByText(NO_DATA)).toBeInTheDocument();
      expect(screen.queryByTestId("mock-area-chart")).not.toBeInTheDocument();
    }
  );

  it.each([
    "chart:prTrend",
    "chart:prTrend:bar",
    "chart:prTrend:heatmap",
    "chart:eventVolume",
    "chart:eventVolume:bar",
    "chart:eventVolume:heatmap",
    "chart:toolRunsOverTime",
    "chart:toolRunsOverTime:bar",
    "chart:toolRunsOverTime:heatmap",
  ])(
    // pins current behavior; looks odd because an all-zero series is a
    // measured result, yet it renders the same "No data yet" state as an
    // absent or uncomputed window (insights/AGENTS.md says the two must be
    // visibly distinct). ISS-10515 pins main; a fix changes the source first.
    "shows the empty state for %s when every value is null or zero",
    (tileId) => {
      const tile = requireTile(tileId);
      renderContent(tile, fullSections(zeroTimeSeries));

      expect(screen.getByText(NO_DATA)).toBeInTheDocument();
      expect(screen.queryByTestId("mock-area-chart")).not.toBeInTheDocument();
      expect(screen.queryByTestId("mock-bar-chart")).not.toBeInTheDocument();
      expect(screen.queryByTestId("mock-heatmap")).not.toBeInTheDocument();
    }
  );
});

describe("InsightsChartContent comparison overlay", () => {
  it.each([
    ["chart:prTrend", InsightsSection.Delivery],
    ["chart:eventActivity", InsightsSection.Utilization],
    ["chart:modelUsageOverTime", InsightsSection.Agents],
  ] as const)(
    "passes the %s comparison series only when that section has a comparison response",
    (tileId, section) => {
      const tile = requireTile(tileId);
      const comparison = fullSections((dataKey) => twoPointTimeSeries(dataKey));
      const { unmount } = renderContent(
        tile,
        fullSections(),
        { [section]: comparison[section] },
        "Organization"
      );
      const chart = screen.getByTestId("mock-area-chart");
      expect(chart).toHaveAttribute("data-comparison-points", "2");
      expect(chart).toHaveAttribute("data-comparison-label", "Organization");
      unmount();

      renderContent(tile, fullSections(), {}, "Organization");
      expect(screen.getByTestId("mock-area-chart")).toHaveAttribute(
        "data-comparison-points",
        "none"
      );
    }
  );
});

describe("InsightsChartContent value formatting and labels", () => {
  it("allows fractional ticks for a currency metric and not for a count metric", () => {
    const { unmount } = renderContent(
      requireTile("chart:modelUsageOverTime:bar"),
      fullSections()
    );
    expect(screen.getByTestId("mock-bar-chart")).toHaveAttribute(
      "data-allow-decimals",
      "true"
    );
    unmount();

    renderContent(requireTile("chart:eventActivity:bar"), fullSections());
    expect(screen.getByTestId("mock-bar-chart")).toHaveAttribute(
      "data-allow-decimals",
      "false"
    );
  });

  it("sums every series per bar and keeps a non-ISO date key verbatim as its label", () => {
    const sections = fullSections();
    const delivery = requireDelivery(sections);
    delivery.charts.prTrend = {
      series: [
        { key: "merged", label: "Merged" },
        { key: "closed", label: "Closed" },
      ],
      points: [
        { date: "2026-04-01", values: { merged: 2, closed: 3 } },
        { date: "week-15", values: { merged: 4 } },
      ],
    };

    renderContent(requireTile("chart:prTrend:bar"), sections);

    const chart = screen.getByTestId("mock-bar-chart");
    expect(within(chart).getByText("04/01=5")).toBeInTheDocument();
    expect(within(chart).getByText("week-15=4")).toBeInTheDocument();
  });

  it("names the heatmap grid after the tile title", () => {
    renderContent(requireTile("chart:eventVolume:heatmap"), fullSections());

    expect(screen.getByTestId("mock-heatmap")).toHaveAttribute(
      "data-label",
      requireTile("chart:eventVolume:heatmap").title
    );
  });

  it.each([
    [
      "a model-grouped series",
      requireTile("chart:modelUsageOverTime"),
      usageOtherSeriesLabel(UsageGrouping.Model),
    ],
    [
      "a provider-grouped series",
      customTile({
        section: InsightsSection.Agents,
        kind: TileKind.TimeSeries,
        dataKey: "modelUsageOverTime",
        groupBy: { key: UsageGrouping.Provider, label: "Provider" },
      }),
      usageOtherSeriesLabel(UsageGrouping.Provider),
    ],
    [
      "a date-grouped series",
      requireTile("chart:eventActivity"),
      GENERIC_OTHER_SERIES,
    ],
  ])("names the aggregate band for %s", (_name, tile, expected) => {
    renderContent(tile, fullSections());

    expect(screen.getByTestId("mock-area-chart")).toHaveAttribute(
      "data-other",
      expected
    );
  });

  it("falls back to the generic aggregate noun for an unmapped or missing donut grouping", () => {
    const { unmount } = renderContent(
      requireTile("chart:prByRepo:donut"),
      fullSections()
    );
    expect(screen.getByTestId("mock-donut-chart")).toHaveAttribute(
      "data-other",
      GENERIC_OTHER_SERIES
    );
    unmount();

    renderContent(
      customTile({
        section: InsightsSection.Delivery,
        kind: TileKind.Donut,
        dataKey: "prByState",
      }),
      fullSections()
    );
    expect(screen.getByTestId("mock-donut-chart")).toHaveAttribute(
      "data-other",
      GENERIC_OTHER_SERIES
    );
  });
});

describe("InsightsChartContent selection and edge cases", () => {
  it("routes only the prByRepo category bar through the segment drilldown", () => {
    const flags = [DELIVERY_SEGMENT_FEATURE_FLAG_KEY];
    const { rerender } = render(
      contentTree({
        tile: requireTile("chart:prByRepo"),
        sections: fullSections(),
        enabledFlags: flags,
      })
    );
    expect(screen.getByText(SEGMENT_PROMPT)).toBeInTheDocument();

    rerender(
      contentTree({
        tile: requireTile("chart:prByState"),
        sections: fullSections(),
        enabledFlags: flags,
      })
    );
    expect(screen.queryByText(SEGMENT_PROMPT)).not.toBeInTheDocument();

    rerender(
      contentTree({
        tile: requireTile("chart:prByRepo:donut"),
        sections: fullSections(),
        enabledFlags: flags,
      })
    );
    expect(screen.queryByText(SEGMENT_PROMPT)).not.toBeInTheDocument();
    expect(screen.getByTestId("mock-donut-chart")).toBeInTheDocument();
  });

  it("keeps the empty state for all-zero repo buckets with the drilldown on", () => {
    render(
      contentTree({
        tile: requireTile("chart:prByRepo"),
        sections: withPrByRepo([
          { key: "acme/web", label: "acme/web", value: 0 },
        ]),
        enabledFlags: [DELIVERY_SEGMENT_FEATURE_FLAG_KEY],
      })
    );

    expect(screen.getByText(NO_DATA)).toBeInTheDocument();
    expect(screen.queryByText(SEGMENT_PROMPT)).not.toBeInTheDocument();
  });

  it("does not resurrect a repo selection after the repo leaves and returns", () => {
    const tile = requireTile("chart:prByRepo");
    const flags = [DELIVERY_SEGMENT_FEATURE_FLAG_KEY];
    const both = withPrByRepo([
      { key: "acme/web", label: "acme/web", value: 6 },
      { key: "acme/api", label: "acme/api", value: 4 },
    ]);
    const { rerender } = render(
      contentTree({ tile, sections: both, enabledFlags: flags })
    );

    fireEvent.click(screen.getByRole("button", { name: "acme/web=6" }));
    expect(screen.getByText("6 · 60% of total · #1 of 2")).toBeInTheDocument();

    rerender(
      contentTree({
        tile,
        sections: withPrByRepo([
          { key: "acme/api", label: "acme/api", value: 4 },
        ]),
        enabledFlags: flags,
      })
    );
    rerender(contentTree({ tile, sections: both, enabledFlags: flags }));

    expect(screen.getByText(SEGMENT_PROMPT)).toBeInTheDocument();
    expect(screen.getByTestId("mock-bar-chart")).toHaveAttribute(
      "data-selected",
      "none"
    );
  });

  // pins current behavior; looks odd because a negative bucket is corrupt
  // input, not a legitimate zero denominator, yet the share renders as a
  // plausible "0%" rather than routing to an unavailable state.
  // ISS-10515 pins main; a fix changes the source first.
  it("reports a 0% share instead of dividing by a zero repo total", () => {
    render(
      contentTree({
        tile: requireTile("chart:prByRepo"),
        sections: withPrByRepo([
          { key: "acme/web", label: "acme/web", value: 5 },
          { key: "acme/api", label: "acme/api", value: -5 },
        ]),
        enabledFlags: [DELIVERY_SEGMENT_FEATURE_FLAG_KEY],
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "acme/web=5" }));

    expect(screen.getByText("5 · 0% of total · #1 of 2")).toBeInTheDocument();
  });

  it("clears a bar selection once the chart's values or series change, even when they change back", () => {
    const tile = requireTile("chart:prTrend:bar");
    const original = singleSeries("merged", [["2026-01-05", 3]]);
    const { rerender } = render(
      contentTree({ tile, sections: withPrTrend(original) })
    );

    fireEvent.click(screen.getByRole("button", { name: "01/05=3" }));
    expect(screen.getByTestId("mock-bar-chart")).toHaveAttribute(
      "data-selected",
      "2026-01-05"
    );

    rerender(
      contentTree({
        tile,
        sections: withPrTrend(singleSeries("merged", [["2026-01-05", 4]])),
      })
    );
    expect(screen.getByTestId("mock-bar-chart")).toHaveAttribute(
      "data-selected",
      "none"
    );
    rerender(contentTree({ tile, sections: withPrTrend(original) }));
    expect(screen.getByTestId("mock-bar-chart")).toHaveAttribute(
      "data-selected",
      "none"
    );

    fireEvent.click(screen.getByRole("button", { name: "01/05=3" }));
    rerender(
      contentTree({
        tile,
        sections: withPrTrend(singleSeries("closed", [["2026-01-05", 3]])),
      })
    );
    expect(screen.getByTestId("mock-bar-chart")).toHaveAttribute(
      "data-selected",
      "none"
    );
  });

  it("shows the generic empty state, not the zero-state copy, for an empty spend payload", () => {
    const sections = fullSections();
    const agents = sections[InsightsSection.Agents];
    agents.charts.spendByOutcome = [];
    const { unmount } = renderContent(
      requireTile("chart:spendByOutcome"),
      sections
    );
    expect(screen.getByText(NO_DATA)).toBeInTheDocument();
    expect(
      screen.queryByText(SPEND_OUTCOME_ZERO_MESSAGE)
    ).not.toBeInTheDocument();
    unmount();

    agents.charts.spendByOutcome = [{ key: "clean", label: "Clean", value: 0 }];
    renderContent(requireTile("chart:spendByOutcome"), sections);
    expect(screen.getByText(SPEND_OUTCOME_ZERO_MESSAGE)).toBeInTheDocument();
  });

  it("builds heatmap weeks from the earliest to the latest date regardless of point order", () => {
    renderContent(
      requireTile("chart:prTrend:heatmap"),
      withPrTrend(
        singleSeries("merged", [
          ["2026-01-14", 2],
          ["2026-01-05", 1],
        ])
      )
    );

    const heatmap = screen.getByTestId("mock-heatmap");
    expect(heatmap).toHaveAttribute("data-weeks", "2");
    expect(within(heatmap).getByText("2026-01-05:1")).toBeInTheDocument();
    expect(within(heatmap).getByText("2026-01-14:2")).toBeInTheDocument();
  });

  it("draws a time series when only one of its series carries data", () => {
    renderContent(
      requireTile("chart:prTrend"),
      withPrTrend({
        series: [
          { key: "merged", label: "Merged" },
          { key: "closed", label: "Closed" },
        ],
        points: [{ date: "2026-01-05", values: { merged: 0, closed: 5 } }],
      })
    );

    expect(screen.getByTestId("mock-area-chart")).toBeInTheDocument();
    expect(screen.queryByText(NO_DATA)).not.toBeInTheDocument();
  });
});

describe("InsightsChartContent reviewer table", () => {
  it("renders reviewer rows when the utilization response carries them", () => {
    renderContent(requireTile("chart:reviewerLoad"), fullSections());

    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.queryByText(NO_DATA)).not.toBeInTheDocument();
  });

  it("shows the empty state when the peer omits reviewer load", () => {
    const sections = fullSections();
    const utilization = sections[InsightsSection.Utilization];
    if (!utilization) {
      throw new Error("Expected utilization fixture");
    }
    utilization.charts.reviewerLoad = undefined;

    renderContent(requireTile("chart:reviewerLoad"), sections);

    expect(screen.getByText(NO_DATA)).toBeInTheDocument();
    expect(screen.queryByText("octocat")).not.toBeInTheDocument();
  });
});

describe("selectKpi", () => {
  it("returns the KPI whose key matches the tile's data key", () => {
    const tile = requireTile("kpi:sessions");
    expect(selectKpi(tile, fullSections())).toEqual(
      kpi("sessions", "Sessions")
    );
  });

  it("returns undefined when the tile's section has not loaded or lacks the key", () => {
    const tile = requireTile("kpi:sessions");
    expect(selectKpi(tile, {})).toBeUndefined();

    const sections = fullSections();
    const utilization = sections[InsightsSection.Utilization];
    if (!utilization) {
      throw new Error("Expected utilization fixture");
    }
    utilization.kpis = [];
    expect(selectKpi(tile, sections)).toBeUndefined();
  });
});

function renderContent(
  tile: TileDescriptor,
  sections: InsightsSectionData,
  comparisonSections?: InsightsSectionData,
  comparisonLabel?: string
) {
  return render(
    contentTree({ tile, sections, comparisonSections, comparisonLabel })
  );
}

function contentTree({
  tile,
  sections,
  comparisonSections,
  comparisonLabel,
  enabledFlags = [],
}: {
  tile: TileDescriptor;
  sections: InsightsSectionData;
  comparisonSections?: InsightsSectionData;
  comparisonLabel?: string;
  enabledFlags?: string[];
}) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <InsightsChartContent
        comparisonLabel={comparisonLabel}
        comparisonSections={comparisonSections}
        sections={sections}
        tile={tile}
      />
    </FeatureFlagAdapterProvider>
  );
}

function withPrTrend(chart: TimeSeries): InsightsSectionData {
  const sections = fullSections();
  requireDelivery(sections).charts.prTrend = chart;
  return sections;
}

function withPrByRepo(prByRepo: CategoryBucket[]): InsightsSectionData {
  const sections = fullSections();
  requireDelivery(sections).charts.prByRepo = prByRepo;
  return sections;
}

function singleSeries(key: string, points: [string, number][]): TimeSeries {
  return {
    series: [{ key, label: key }],
    points: points.map(([date, value]) => ({ date, values: { [key]: value } })),
  };
}

function requireTile(id: string): TileDescriptor {
  const tile = getTile(id);
  if (!tile) {
    throw new Error(`Expected catalog tile ${id}`);
  }
  return tile;
}

function requireDelivery(
  sections: InsightsSectionData
): DeliveryInsightsResponse {
  const delivery = sections[InsightsSection.Delivery];
  if (!delivery) {
    throw new Error("Expected delivery fixture");
  }
  return delivery;
}

function customTile({
  section,
  kind,
  dataKey,
  groupBy,
}: {
  section: InsightsSection;
  kind: ChartTileDescriptor["kind"];
  dataKey: string;
  groupBy?: ChartTileDescriptor["groupBy"];
}): ChartTileDescriptor {
  return {
    id: `custom:${section}:${kind}:${dataKey}`,
    section,
    title: "Custom tile",
    kind,
    dataKey,
    metricKey: "sessions",
    metricLabel: "Sessions",
    ...(groupBy ? { groupBy } : {}),
    grid: { w: 6, h: 4 },
  };
}

function kpi(key: string, label: string): KpiStat {
  return {
    key,
    label,
    value: 1,
    format: KpiFormat.Number,
    sub: "",
    deltaPct: null,
  };
}

function bucket(dataKey: string): CategoryBucket[] {
  return [{ key: `${dataKey}-key`, label: `${dataKey} bucket`, value: 4 }];
}

type SeriesBuilder = (dataKey: string) => TimeSeries;

function populatedTimeSeries(dataKey: string): TimeSeries {
  return {
    series: [{ key: SERIES_KEY, label: `${dataKey} series` }],
    points: [
      {
        date: TIME_SERIES_DATES[dataKey],
        values: { [SERIES_KEY]: TIME_SERIES_VALUES[dataKey] },
      },
    ],
  };
}

function twoPointTimeSeries(dataKey: string): TimeSeries {
  return {
    series: [{ key: SERIES_KEY, label: `${dataKey} series` }],
    points: [
      { date: "2026-05-01", values: { [SERIES_KEY]: 1 } },
      { date: "2026-05-02", values: { [SERIES_KEY]: 2 } },
    ],
  };
}

function zeroTimeSeries(dataKey: string): TimeSeries {
  return {
    series: [{ key: SERIES_KEY, label: `${dataKey} series` }],
    points: [
      { date: "2026-06-01", values: { [SERIES_KEY]: null } },
      { date: "2026-06-02", values: { [SERIES_KEY]: 0 } },
      { date: "2026-06-03", values: {} },
    ],
  };
}

function fullSections(
  series: SeriesBuilder = populatedTimeSeries
): Required<InsightsSectionData> {
  const delivery: DeliveryInsightsResponse = {
    kpis: [kpi("merged", "Merged PRs")],
    charts: {
      prTrend: series("prTrend"),
      klocTrend: series("klocTrend"),
      prByRepo: bucket("prByRepo"),
      meanTimeToMerge: bucket("meanTimeToMerge"),
      prByState: bucket("prByState"),
      checkStatus: bucket("checkStatus"),
      branchLifespan: bucket("branchLifespan"),
      branchesWithoutPr: bucket("branchesWithoutPr"),
    },
  };
  const utilization: UtilizationInsightsResponse = {
    kpis: [kpi("sessions", "Sessions")],
    charts: {
      eventActivity: series("eventActivity"),
      eventVolume: series("eventVolume"),
      eventsByType: bucket("eventsByType"),
      userBreakdown: bucket("userBreakdown"),
      reviewerLoad: [
        {
          reviewer: "octocat",
          reviewed: 3,
          approved: 2,
          medianWaitMs: null,
        },
      ],
      reviewQueue: bucket("reviewQueue"),
    },
  };
  const agents: AgentsInsightsResponse = {
    kpis: [kpi("tool-runs", "Tool runs")],
    charts: {
      modelUsageOverTime: series("modelUsageOverTime"),
      toolRunsOverTime: series("toolRunsOverTime"),
      modelBreakdown: bucket("modelBreakdown"),
      tokenDistribution: bucket("tokenDistribution"),
      toolUsage: bucket("toolUsage"),
      agentsByStatus: bucket("agentsByStatus"),
      agentsByType: bucket("agentsByType"),
      spendByOutcome: bucket("spendByOutcome"),
    },
  };
  return {
    [InsightsSection.Delivery]: delivery,
    [InsightsSection.Utilization]: utilization,
    [InsightsSection.Agents]: agents,
  };
}
