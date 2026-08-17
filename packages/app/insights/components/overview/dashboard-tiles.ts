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
/**
 * The closed set of dashboard row identities (each is a `data-tour` anchor and
 * the stable per-row key). Exported as a const union so any registry keyed by
 * row — e.g. `ROW_SECTIONS` in `dashboard-row-sections.ts` — is exhaustive: a
 * new row added here fails typecheck until it declares its section dependencies,
 * rather than silently skipping the per-row loading gate.
 */
export const DashboardRowTour = {
  Stats: "stats",
  Activity: "activity",
  Models: "models",
  AgentPipeline: "agent-pipeline",
  Autonomy: "autonomy",
  Frustration: "frustration",
  Prs: "prs",
  Distribution: "distribution",
} as const;
export type DashboardRowTour =
  (typeof DashboardRowTour)[keyof typeof DashboardRowTour];

export type DashboardRow = {
  /** Tour anchor key (matches the tour step `sel`). */
  tour: DashboardRowTour;
  /** Catalog tile ids, left-to-right. */
  tileIds: string[];
};

/**
 * Every dashboard row, in order — the UNGATED superset. Neither shell maps this
 * array directly: both resolve their row order through {@link dashboardRowsFor}
 * so a closed-by-default row is dropped from the order, and then apply their own
 * data-driven filtering on top (a desktop-only chart the cloud API omits, and
 * the agent-pipeline row's absent-data filter).
 */
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
  // How the agents collaborate. Rendered by <AgentPipelineGraph/> directly below
  // the model-usage chart (FEA-3537) — not a catalog tile. ISS-5061: gated by
  // `DashboardRowGates.agentCollaborationNetwork` (this row's presence is
  // resolved through `dashboardRowsFor`, NOT by reading this list directly).
  { tour: "agent-pipeline", tileIds: [] },
  // How hands-off the work was. Rendered by <AutonomyTrendChart/> — not a
  // catalog tile.
  { tour: "autonomy", tileIds: [] },
  // How frustrated the sessions were (FEA-4022). Rendered by
  // <FrustrationTrendChart/> — not a catalog tile; org opt-in gated, so the row
  // only appears when the API returns the series.
  { tour: "frustration", tileIds: [] },
  // Shipping velocity.
  { tour: "prs", tileIds: ["chart:prTrend"] },
  // Spend by model + per-repository PR breakdown.
  {
    tour: "distribution",
    tileIds: ["chart:modelBreakdown", "chart:prByRepo"],
  },
];

/** Resolve a row's tile descriptors, dropping any unknown id. */
export function resolveRowTiles(row: DashboardRow): TileDescriptor[] {
  return row.tileIds
    .map((id) => getTile(id))
    .filter((tile): tile is TileDescriptor => tile !== undefined);
}

/**
 * Closed-by-default gates that decide whether a dashboard row EXISTS at all
 * (ISS-4779). Distinct from the data-driven `visibleRows` filtering each shell
 * already does (a desktop-only chart the cloud API omits; the agent-pipeline
 * row's own absent-data filter): those rows exist and are dropped once their
 * data resolves absent, whereas a gated-off row is never part of the dashboard
 * in the first place — no card, no skeleton, no grid slot.
 */
export type DashboardRowGates = {
  /**
   * ISS-5061: the "Agent Collaboration Network" row (`agent-pipeline`). Off (the
   * default) removes the row entirely rather than degrading to the graph's own
   * "No agent collaboration data" empty state, which would claim there is no
   * data when the feature is simply off.
   *
   * Re-introduced after ISS-5280 (#4482) retired it; see
   * `@repo/api/src/types/agent-collaboration-network-flag`.
   */
  agentCollaborationNetwork: boolean;
};

/**
 * Whether a row survives the closed-by-default gates. The single predicate both
 * shells and every per-row switch consult, so the row cannot be present in one
 * touchpoint (row order, render, skeleton, section loading) and absent in
 * another.
 */
export function isDashboardRowEnabled(
  row: DashboardRow,
  gates: DashboardRowGates
): boolean {
  if (row.tour === DashboardRowTour.AgentPipeline) {
    return gates.agentCollaborationNetwork;
  }
  return true;
}

/**
 * The dashboard row order with gated-off rows removed. Both shells derive their
 * row list from this instead of mapping {@link DASHBOARD_ROWS} directly, so the
 * rows below a gated-off row close up rather than leaving a blank slot.
 */
export function dashboardRowsFor(gates: DashboardRowGates): DashboardRow[] {
  return DASHBOARD_ROWS.filter((row) => isDashboardRowEnabled(row, gates));
}
