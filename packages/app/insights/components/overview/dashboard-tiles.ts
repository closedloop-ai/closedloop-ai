import {
  getTile,
  type TileDescriptor,
} from "@repo/app/insights/lib/tile-catalog";

/**
 * The fixed, non-editable tile layout for the overview Dashboard (shared by the
 * web shell and the desktop first-launch dashboard). Unlike the Insights page (a
 * draggable, pinnable grid), this is a curated read-only overview composed from
 * the same shared tile catalog — so the widgets stay identical to the rest of
 * the product while the layout is fixed.
 *
 * Each row is a `data-tour` anchor target for the desktop guided tour.
 * `resolveRowTiles` drops any unknown tile id at render, so a typo would
 * silently blank a row; `dashboard-tiles.test.ts` asserts every wired tile id
 * resolves in the catalog so a typo fails fast in tests instead.
 */
export type DashboardRow = {
  /** Tour anchor key (matches the tour step `sel`). */
  tour: string;
  /** Catalog tile ids, left-to-right. */
  tileIds: string[];
};

export const DASHBOARD_ROWS: DashboardRow[] = [
  // Headline KPIs (Sessions, Token spend, PRs shipped, PR size, KLOC merged).
  {
    tour: "stats",
    tileIds: [
      "kpi:sessions",
      "kpi:cost",
      "kpi:merged",
      "kpi:pr-size",
      "kpi:kloc",
    ],
  },
  // When the work happens. Rendered by <EventActivityHeatmap/> (hour×day,
  // human/agent toggle), not a catalog tile — kept here for row order + the
  // tour anchor.
  { tour: "activity", tileIds: [] },
  // Which models did the work. Rendered by <ModelUsageChart/> (stacked, with a
  // By model / By provider toggle) — not a catalog tile.
  { tour: "models", tileIds: [] },
  // How hands-off the work was. Rendered by <AutonomyTrendChart/> — not a
  // catalog tile.
  { tour: "autonomy", tileIds: [] },
  // Shipping velocity + per-repository breakdown.
  { tour: "prs", tileIds: ["chart:prTrend", "chart:prByRepo"] },
  // Token share by model + session status distribution.
  {
    tour: "distribution",
    tileIds: ["chart:modelBreakdown", "chart:sessionsByStatus"],
  },
];

/** Resolve a row's tile descriptors, dropping any unknown id. */
export function resolveRowTiles(row: DashboardRow): TileDescriptor[] {
  return row.tileIds
    .map((id) => getTile(id))
    .filter((tile): tile is TileDescriptor => tile !== undefined);
}
