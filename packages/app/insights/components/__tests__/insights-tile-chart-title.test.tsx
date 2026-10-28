/**
 * A chart tile's heading is the catalog title on every surface (ISS-12638,
 * operator ruling: titles are the same in single-user and logged-in mode).
 *
 * The desktop producer labels its KLOC series and KPI with the captured-PR noun
 * while the catalog says "KLOC merged". These drive the real `InsightsTile` with
 * those conflicting labels and assert the heading, the expand control, the
 * modal's accessible name and the heatmap's grid name all stay on the catalog
 * title, so a card never renames itself from the response it is given.
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

const PRODUCER_METRIC_LABEL = "KLOC captured";
const KLOC_METRIC_KEY = "kloc";

describe("chart tile headings follow the catalog, not the response (ISS-12638)", () => {
  it("keeps the catalog heading when the series and the KPI carry another noun", async () => {
    const user = userEvent.setup();
    const catalogTitle = tile("chart:klocTrend").title;
    renderTile(
      "chart:klocTrend",
      sections({
        kpiLabel: PRODUCER_METRIC_LABEL,
        seriesLabel: PRODUCER_METRIC_LABEL,
      })
    );

    expect(cardHeading(catalogTitle)).toBeInTheDocument();
    expect(
      screen.queryByText(`${PRODUCER_METRIC_LABEL} over time`)
    ).not.toBeInTheDocument();
    // The expand control and the modal it opens name the same chart.
    await user.click(
      screen.getByRole("button", { name: `Expand ${catalogTitle}` })
    );
    expect(screen.getByRole("dialog")).toHaveAccessibleName(catalogTitle);
  });

  it.each(["chart:klocTrend:bar", "chart:klocTrend:heatmap"])(
    "keeps %s on its catalog heading",
    (tileId) => {
      const catalogTitle = tile(tileId).title;
      renderTile(tileId, sections({ seriesLabel: PRODUCER_METRIC_LABEL }));

      expect(cardHeading(catalogTitle)).toBeInTheDocument();
    }
  );

  it("names the heatmap grid with the catalog heading too", () => {
    const catalogTitle = tile("chart:klocTrend:heatmap").title;
    renderTile(
      "chart:klocTrend:heatmap",
      sections({ seriesLabel: PRODUCER_METRIC_LABEL })
    );

    expect(
      screen.getByRole("grid", { name: catalogTitle })
    ).toBeInTheDocument();
  });

  it("keeps the catalog title when the producer omits the series", () => {
    const catalogTitle = tile("chart:klocTrend").title;
    renderTile(
      "chart:klocTrend",
      sections({ kpiLabel: PRODUCER_METRIC_LABEL })
    );

    expect(cardHeading(catalogTitle)).toBeInTheDocument();
  });

  it("leaves a tile whose series are not headings on its catalog title", () => {
    const response = sections({ seriesLabel: PRODUCER_METRIC_LABEL });
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
