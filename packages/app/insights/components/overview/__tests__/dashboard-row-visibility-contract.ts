import { InsightsSection } from "@repo/api/src/types/insights";
import type { InsightsSectionData } from "../../tile-content";
import { visibleDashboardRows } from "../dashboard-row-sections";
import { DashboardRowTour } from "../dashboard-tiles";

/**
 * ISS-9993: the both-host contract for which dashboard rows exist. The web
 * (`InsightsOverviewDashboard`) and desktop (`FirstLaunchDashboard`) suites each
 * render these settled payloads and assert the rows they drew equal
 * {@link expectedRowTours} for the same payloads. A host that filters a row by
 * hand, or draws a row the shared rule drops, fails its own suite.
 */

export type RowDataPayloads = {
  delivery: object;
  utilization: object;
  agents: object;
};

const EMPTY_SERIES = { series: [], points: [] };

/** Settled payloads with none of the data a data-conditional row needs. */
export const NO_ROW_DATA: RowDataPayloads = {
  delivery: { kpis: [], charts: {} },
  utilization: { kpis: [], charts: {} },
  agents: { kpis: [], charts: { modelBreakdown: [] } },
};

/** Settled payloads with every data-conditional row's data. */
export const ALL_ROW_DATA: RowDataPayloads = {
  delivery: { kpis: [], charts: {} },
  utilization: {
    kpis: [],
    charts: { activityHeatmap: { days: [], cells: [] } },
  },
  agents: {
    kpis: [],
    charts: {
      modelBreakdown: [],
      autonomyTrend: EMPTY_SERIES,
      frustrationTrend: EMPTY_SERIES,
      agentPipeline: {
        nodes: [{ id: "researcher", label: "researcher", value: 4 }],
        edges: [],
      },
    },
  },
};

/**
 * The rows the shared rule keeps for fully settled payloads, with the
 * closed-by-default gate open so only the data shape decides.
 */
export function expectedRowTours(payloads: RowDataPayloads): string[] {
  const sections = {
    [InsightsSection.Delivery]: payloads.delivery,
    [InsightsSection.Utilization]: payloads.utilization,
    [InsightsSection.Agents]: payloads.agents,
  } as InsightsSectionData;
  return visibleDashboardRows({
    gates: { agentCollaborationNetwork: true },
    sections,
    sectionLoading: {
      [InsightsSection.Delivery]: false,
      [InsightsSection.Utilization]: false,
      [InsightsSection.Agents]: false,
    },
  }).map((row) => row.tour);
}

/** The row anchors a host rendered, in document order. */
export function renderedRowTours(root: ParentNode): string[] {
  return [...root.querySelectorAll("[data-tour]")]
    .map((element) => element.getAttribute("data-tour") ?? "")
    .filter((tour) => ROW_TOURS.has(tour));
}

const ROW_TOURS: ReadonlySet<string> = new Set(Object.values(DashboardRowTour));
