/**
 * ISS-5507 — a chart tile's heading must name the population the RESPONSE sent.
 *
 * `chart:klocTrend` is one catalog entry drawn from two producers with different
 * populations: the cloud service sums MERGED PRs and labels its series "KLOC
 * merged", while the desktop local backend sums CAPTURED PRs and labels its own
 * "KLOC captured" (the merged-vs-captured split FEA-2947 and the desktop
 * "KLOC captured" KPI exist to keep straight). The catalog title was hardcoded
 * to the cloud wording and rendered verbatim, so a desktop-shaped response drew
 * "KLOC merged over time" above a legend reading "KLOC captured".
 *
 * These drive the real `InsightsTile` rather than calling `chartTileTitle`
 * directly, so deleting the resolution from the card shell fails here instead of
 * leaving a green helper nobody calls. Between them they cover every branch of
 * that helper: no suffix, series label, KPI-label fallback, and neither loaded.
 */

import type {
  DeliveryInsightsResponse,
  KpiStat,
  TimeSeries,
} from "@repo/api/src/types/insights";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { getTile, type TileDescriptor } from "../../lib/tile-catalog";
import { InsightsTile } from "../insights-tile";
import type { InsightsSectionData } from "../tile-content";

// Recharts measures a container jsdom gives no size, so the real area/bar charts
// render nothing useful and only add noise. The heatmap is NOT mocked — its
// sr-only grid label is one of the strings under test.
vi.mock("@repo/design-system/components/ui/time-series-area-chart", () => ({
  TimeSeriesAreaChart: () => <div data-testid="area-chart" />,
}));
vi.mock("@repo/design-system/components/ui/category-bar-chart", () => ({
  CategoryBarChart: () => <div data-testid="bar-chart" />,
}));

const CLOUD_METRIC_LABEL = "KLOC merged";
const DESKTOP_METRIC_LABEL = "KLOC captured";
const KLOC_METRIC_KEY = "kloc";

describe("chart tile heading resolution (ISS-5507)", () => {
  // The two sources are given CONFLICTING labels on purpose: a response carries
  // both, so a fixture where they agree cannot tell series-first precedence from
  // KPI-first. Cloud sends the merged series; the KPI beside it is deliberately
  // the desktop noun, and it must lose.
  it("keeps the cloud heading, preferring the series label over a conflicting KPI label", () => {
    renderTile(
      "chart:klocTrend",
      sections({
        kpiLabel: DESKTOP_METRIC_LABEL,
        seriesLabel: CLOUD_METRIC_LABEL,
      })
    );

    expect(cardHeading("KLOC merged over time")).toBeInTheDocument();
    expect(
      screen.queryByText("KLOC captured over time")
    ).not.toBeInTheDocument();
  });

  it("names the captured population when the desktop producer labels the series", async () => {
    const user = userEvent.setup();
    renderTile(
      "chart:klocTrend",
      sections({ seriesLabel: DESKTOP_METRIC_LABEL })
    );

    expect(cardHeading("KLOC captured over time")).toBeInTheDocument();
    expect(screen.queryByText("KLOC merged over time")).not.toBeInTheDocument();
    // The expand control names the same chart the heading does.
    await user.click(
      screen.getByRole("button", { name: "Expand KLOC captured over time" })
    );

    // So does the modal it opens — whose accessible name comes from a SEPARATE
    // `ExpandableWidget title` prop, so pinning the button label alone leaves
    // reverting that prop to the catalog title green.
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "KLOC captured over time"
    );
  });

  it("resolves the bar variant's heading from the same series", () => {
    renderTile(
      "chart:klocTrend:bar",
      sections({ seriesLabel: DESKTOP_METRIC_LABEL })
    );

    expect(cardHeading("KLOC captured by day")).toBeInTheDocument();
  });

  it("resolves the heatmap's heading and its sr-only grid label together", () => {
    renderTile(
      "chart:klocTrend:heatmap",
      sections({ seriesLabel: DESKTOP_METRIC_LABEL })
    );

    expect(cardHeading("KLOC captured heatmap")).toBeInTheDocument();
    // `ActivityHeatmap` points the grid's `aria-labelledby` at this node, so an
    // unresolved label would leave the screen-reader name contradicting the
    // visible heading.
    expect(
      screen.getByRole("grid", { name: "KLOC captured heatmap" })
    ).toBeInTheDocument();
  });

  // The heading and the grid's accessible name are resolved at two call sites,
  // so they are given the SAME two sources. A series whose key the tile does not
  // know is the case that pulls them apart: it is data (so the heatmap draws and
  // does need a name) while naming no metric, and only a producer — not this
  // repo's types — decides the key.
  it("keeps the heatmap's accessible name equal to its heading when the series names no known metric", () => {
    const response = sections({ kpiLabel: DESKTOP_METRIC_LABEL });
    const delivery = response[InsightsSection.Delivery];
    if (delivery) {
      delivery.charts.klocTrend = {
        series: [{ key: "kloc-v2", label: "KLOC captured (v2)" }],
        points: [{ date: "2026-05-15", values: { "kloc-v2": 3.2 } }],
      };
    }

    renderTile("chart:klocTrend:heatmap", response);

    expect(cardHeading("KLOC captured heatmap")).toBeInTheDocument();
    expect(
      screen.getByRole("grid", { name: "KLOC captured heatmap" })
    ).toBeInTheDocument();
  });

  // ISS-5412: desktop OMITS `klocTrend` entirely when no captured PR can be
  // sized. The card is empty either way, but it still has to name the right
  // population — and the KPI stat for the same metric is the only noun left.
  it("falls back to the section's KPI label when the producer omits the series", () => {
    renderTile("chart:klocTrend", sections({ kpiLabel: DESKTOP_METRIC_LABEL }));

    expect(cardHeading("KLOC captured over time")).toBeInTheDocument();
  });

  it("keeps the catalog title while the response is still loading", () => {
    renderTile("chart:klocTrend", {});

    expect(cardHeading("KLOC merged over time")).toBeInTheDocument();
  });

  // A tile whose heading is fixed copy must not start echoing a series label:
  // desktop splits `prTrend` into "Agent-raised"/"Manual" series, neither of
  // which is a heading.
  it("leaves a tile that declares no suffix on its catalog title", () => {
    const response = sections({ seriesLabel: DESKTOP_METRIC_LABEL });
    response[InsightsSection.Delivery]?.charts.prTrend.series.push({
      key: "merged",
      label: "Agent-raised",
    });

    renderTile("chart:prTrend", response);

    expect(cardHeading("PR throughput")).toBeInTheDocument();
  });
});

function renderTile(tileId: string, sectionData: InsightsSectionData) {
  render(
    <InsightsTile pinned={false} sections={sectionData} tile={tile(tileId)} />
  );
}

function tile(tileId: string): TileDescriptor {
  const descriptor = getTile(tileId);
  if (!descriptor) {
    throw new Error(`Unknown tile id in fixture: ${tileId}`);
  }
  return descriptor;
}

/**
 * The card's own heading. Scoped to the header because the heatmap's sr-only
 * grid label carries the same resolved string in the card body.
 */
function cardHeading(text: string) {
  return screen.getByText(text, {
    selector: '[data-slot="card-header"] span',
  });
}

function klocSeries(label: string): TimeSeries {
  return {
    series: [{ key: KLOC_METRIC_KEY, label }],
    points: [{ date: "2026-05-15", values: { [KLOC_METRIC_KEY]: 3.2 } }],
  };
}

function klocKpi(label: string): KpiStat {
  return {
    key: KLOC_METRIC_KEY,
    label,
    value: null,
    format: KpiFormat.Number,
    sub: "thousands of lines changed in captured PRs",
    deltaPct: null,
  };
}

function sections(input: {
  seriesLabel?: string;
  kpiLabel?: string;
}): InsightsSectionData {
  const delivery: DeliveryInsightsResponse = {
    kpis: input.kpiLabel ? [klocKpi(input.kpiLabel)] : [],
    charts: {
      prTrend: { series: [], points: [] },
      ...(input.seriesLabel
        ? { klocTrend: klocSeries(input.seriesLabel) }
        : {}),
      prByRepo: [],
      meanTimeToMerge: [],
      prByState: [],
      branchLifespan: [],
      branchesWithoutPr: [],
    },
  };
  return { [InsightsSection.Delivery]: delivery };
}
