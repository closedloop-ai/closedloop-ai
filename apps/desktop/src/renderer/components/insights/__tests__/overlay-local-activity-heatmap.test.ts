import type { UtilizationInsightsResponse } from "@closedloop-ai/loops-api/insights";
import { describe, expect, it } from "vitest";
import { overlayLocalActivityHeatmap } from "../overlay-local-activity-heatmap";

const HEATMAP = {
  days: ["2026-07-01", "2026-07-02"],
  cells: [
    { day: "2026-07-01", hour: 9, human: 3, agent: 5 },
    { day: "2026-07-02", hour: 14, human: 0, agent: 7 },
  ],
};

function utilization(
  charts: Partial<UtilizationInsightsResponse["charts"]> = {}
): UtilizationInsightsResponse {
  return {
    kpis: [],
    charts: {
      eventActivity: { series: [], points: [] },
      reviewQueue: [],
      ...charts,
    },
  } as UtilizationInsightsResponse;
}

describe("overlayLocalActivityHeatmap", () => {
  it("fills the heatmap from the local read when the cloud response omits it entirely", () => {
    const cloud = utilization();
    const local = utilization({ activityHeatmap: HEATMAP });

    const result = overlayLocalActivityHeatmap(cloud, local);

    expect(result.charts.activityHeatmap?.cells).toHaveLength(2);
    expect(result.charts.activityHeatmap).toEqual(HEATMAP);
  });

  it("fills the heatmap when the cloud response carries an empty-cells heatmap", () => {
    const cloud = utilization({
      activityHeatmap: { days: ["2026-07-01"], cells: [] },
    });
    const local = utilization({ activityHeatmap: HEATMAP });

    const result = overlayLocalActivityHeatmap(cloud, local);

    expect(result.charts.activityHeatmap?.cells).toHaveLength(2);
    expect(result.charts.activityHeatmap).toEqual(HEATMAP);
  });

  it("preserves a populated cloud heatmap instead of overlaying local", () => {
    const cloudHeatmap = {
      days: ["2026-07-05"],
      cells: [{ day: "2026-07-05", hour: 1, human: 1, agent: 1 }],
    };
    const cloud = utilization({ activityHeatmap: cloudHeatmap });
    const local = utilization({ activityHeatmap: HEATMAP });

    const result = overlayLocalActivityHeatmap(cloud, local);

    expect(result.charts.activityHeatmap).toEqual(cloudHeatmap);
  });

  it("leaves the cloud response untouched when there is no local read", () => {
    const cloud = utilization();

    const result = overlayLocalActivityHeatmap(cloud, undefined);

    expect(result.charts.activityHeatmap).toBeUndefined();
    expect(result).toBe(cloud);
  });

  it("leaves the cloud response untouched when the local heatmap is also empty", () => {
    const cloud = utilization();
    const local = utilization({
      activityHeatmap: { days: [], cells: [] },
    });

    const result = overlayLocalActivityHeatmap(cloud, local);

    expect(result.charts.activityHeatmap).toBeUndefined();
    expect(result).toBe(cloud);
  });

  it("does not mutate the input cloud response when overlaying", () => {
    const cloud = utilization();
    const local = utilization({ activityHeatmap: HEATMAP });

    overlayLocalActivityHeatmap(cloud, local);

    expect(cloud.charts.activityHeatmap).toBeUndefined();
  });
});
