import {
  getTile,
  isKpiTile,
  REMOVED_DASHBOARD_TILE_IDS,
} from "@repo/app/insights/lib/tile-catalog";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_ROWS,
  DashboardRowTour,
  dashboardRowsFor,
  isDashboardRowEnabled,
  resolveRowTiles,
} from "../dashboard-tiles";

/**
 * Makes the "a typo fails fast in tests" guarantee real: every tile id wired
 * into DASHBOARD_ROWS must resolve in the shared catalog. Without this,
 * `resolveRowTiles` silently drops an unknown id at render and the row just
 * goes missing in the running app.
 */
describe("DASHBOARD_ROWS tile ids", () => {
  const wiredIds = DASHBOARD_ROWS.flatMap((row) => row.tileIds);

  it.each(wiredIds)("'%s' resolves in the shared tile catalog", (id) => {
    expect(getTile(id)).toBeDefined();
  });

  it("resolveRowTiles drops nothing for any configured row", () => {
    for (const row of DASHBOARD_ROWS) {
      expect(resolveRowTiles(row)).toHaveLength(row.tileIds.length);
    }
  });

  // ISS-4633: the stats row renders KPI cards, and only a KPI tile carries the
  // `polarity` its delta chip needs. A chart id wired into this row would be
  // dropped at render, so it has to fail here instead.
  it("wires only KPI tiles into the stats row", () => {
    const statsRow = DASHBOARD_ROWS.find(
      (row) => row.tour === DashboardRowTour.Stats
    );
    expect(statsRow).toBeDefined();
    const tiles = resolveRowTiles(
      statsRow ?? { tour: DashboardRowTour.Stats, tileIds: [] }
    );
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every(isKpiTile)).toBe(true);
  });

  it("removes session status distribution from the fixed overview dashboard", () => {
    expect(wiredIds).not.toContain(REMOVED_DASHBOARD_TILE_IDS.SessionsByStatus);
  });

  it("makes PR throughput full-width and pairs PR repository breakdown with model spend", () => {
    expect(DASHBOARD_ROWS.find((row) => row.tour === "prs")?.tileIds).toEqual([
      "chart:prTrend",
    ]);
    expect(
      DASHBOARD_ROWS.find((row) => row.tour === "distribution")?.tileIds
    ).toEqual(["chart:modelBreakdown", "chart:prByRepo"]);
  });
});

/**
 * ISS-5061 re-gate (reverses ISS-5280 for this one flag). `dashboardRowsFor` is
 * the single predicate both shells derive their row order from, so a row cannot
 * be present in one touchpoint and absent in another.
 */
describe("dashboardRowsFor closed-by-default gates", () => {
  const agentPipelineRow = DASHBOARD_ROWS.find(
    (row) => row.tour === DashboardRowTour.AgentPipeline
  );

  it("keeps the agent-pipeline row in the ungated superset", () => {
    // Guards against the assertions below passing vacuously if the row were
    // ever dropped from DASHBOARD_ROWS outright.
    expect(agentPipelineRow).toBeDefined();
  });

  it("drops the agent-pipeline row when its gate is closed", () => {
    const rows = dashboardRowsFor({ agentCollaborationNetwork: false });

    expect(rows).not.toContain(agentPipelineRow);
    // Every OTHER row survives, so the gate is targeted rather than a filter
    // that empties the dashboard.
    expect(rows).toHaveLength(DASHBOARD_ROWS.length - 1);
  });

  it("keeps the agent-pipeline row when its gate is open", () => {
    const rows = dashboardRowsFor({ agentCollaborationNetwork: true });

    expect(rows).toEqual(DASHBOARD_ROWS);
  });

  it("gates only the agent-pipeline row", () => {
    for (const row of DASHBOARD_ROWS) {
      const gatedOff = isDashboardRowEnabled(row, {
        agentCollaborationNetwork: false,
      });
      expect(gatedOff).toBe(row.tour !== DashboardRowTour.AgentPipeline);
      expect(
        isDashboardRowEnabled(row, { agentCollaborationNetwork: true })
      ).toBe(true);
    }
  });
});
