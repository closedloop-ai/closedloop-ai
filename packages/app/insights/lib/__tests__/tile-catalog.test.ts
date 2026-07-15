import { INSIGHTS_SECTION_OPTIONS } from "@repo/api/src/types/insights";
import { describe, expect, it } from "vitest";
import { getMetricInfo } from "../metric-info";
import {
  DEFAULT_DASHBOARD_TILE_IDS,
  getSectionTiles,
  getTile,
  INSIGHTS_TILES,
  REMOVED_DASHBOARD_TILE_IDS,
  TileKind,
} from "../tile-catalog";

describe("tile catalog", () => {
  it("has unique tile ids", () => {
    const ids = INSIGHTS_TILES.map((tile) => tile.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("assigns every tile to a known section", () => {
    for (const tile of INSIGHTS_TILES) {
      expect(INSIGHTS_SECTION_OPTIONS).toContain(tile.section);
    }
  });

  it("partitions tiles across sections with getSectionTiles", () => {
    const total = INSIGHTS_SECTION_OPTIONS.reduce(
      (sum, section) => sum + getSectionTiles(section).length,
      0
    );
    expect(total).toBe(INSIGHTS_TILES.length);
  });

  it("resolves tiles by id and returns undefined for unknown ids", () => {
    expect(getTile("kpi:merged")?.title).toBe("Merged PRs");
    expect(getTile("nope")).toBeUndefined();
  });

  it("has metric-info copy for every tile", () => {
    for (const tile of INSIGHTS_TILES) {
      expect(getMetricInfo(tile.id)).toBeDefined();
    }
  });

  it("only defaults to tiles that exist", () => {
    for (const id of DEFAULT_DASHBOARD_TILE_IDS) {
      expect(getTile(id)).toBeDefined();
    }
  });

  it("does not expose retired sessions-by-status dashboard tiles", () => {
    for (const id of Object.values(REMOVED_DASHBOARD_TILE_IDS)) {
      expect(DEFAULT_DASHBOARD_TILE_IDS).not.toContain(id);
      expect(getTile(id)).toBeUndefined();
    }
  });

  it("exposes unit labels for line-based KPI tiles", () => {
    expect(getTile("kpi:pr-size")?.unitLabel).toBe("lines");
    expect(getTile("kpi:kloc")?.unitLabel).toBe("KLOC");
  });

  it("keeps runtime availability out of the static catalog", () => {
    for (const tile of INSIGHTS_TILES) {
      expect(tile).not.toHaveProperty("availability");
      expect(tile).not.toHaveProperty("state");
    }
  });

  it("exposes multiple visualizations for data-backed metric choices", () => {
    expect(kindsForMetric("kloc", "date")).toEqual([
      TileKind.TimeSeries,
      TileKind.TimeSeriesBar,
      TileKind.Heatmap,
    ]);
    expect(kindsForMetric("models", "model")).toEqual([
      TileKind.CategoryBar,
      TileKind.Donut,
    ]);
    expect(kindsForMetric("tool-runs", "date")).toEqual([
      TileKind.TimeSeries,
      TileKind.TimeSeriesBar,
      TileKind.Heatmap,
    ]);
  });
});

function kindsForMetric(metricKey: string, groupBy: string): string[] {
  return INSIGHTS_TILES.filter(
    (tile) => tile.metricKey === metricKey && tile.groupBy?.key === groupBy
  ).map((tile) => tile.kind);
}
