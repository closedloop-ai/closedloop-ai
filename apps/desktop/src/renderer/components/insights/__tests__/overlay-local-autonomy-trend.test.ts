import type {
  AgentsInsightsResponse,
  TimeSeries,
} from "@closedloop-ai/loops-api/insights";
import { describe, expect, it } from "vitest";
import { overlayLocalAutonomyTrend } from "../overlay-local-autonomy-trend";

const AUTONOMY: TimeSeries = {
  series: [{ key: "autonomy", label: "Autonomy" }],
  points: [
    { date: "2026-07-01", values: { autonomy: 40 } },
    { date: "2026-07-02", values: { autonomy: null } },
    { date: "2026-07-03", values: { autonomy: 75 } },
  ],
};

// A gap-filled series with no measured days (no sessions in range) — every
// point is null, mirroring the desktop `gapFilledSeries(..., null)` output.
const EMPTY_AUTONOMY: TimeSeries = {
  series: [{ key: "autonomy", label: "Autonomy" }],
  points: [
    { date: "2026-07-01", values: { autonomy: null } },
    { date: "2026-07-02", values: { autonomy: null } },
  ],
};

function agents(
  charts: Partial<AgentsInsightsResponse["charts"]> = {}
): AgentsInsightsResponse {
  return {
    kpis: [],
    charts: {
      modelUsageOverTime: { series: [], points: [] },
      modelBreakdown: [],
      ...charts,
    },
  } as AgentsInsightsResponse;
}

describe("overlayLocalAutonomyTrend", () => {
  it("fills the trend from the local read when the cloud response omits it entirely", () => {
    const cloud = agents();
    const local = agents({ autonomyTrend: AUTONOMY });

    const result = overlayLocalAutonomyTrend(cloud, local);

    expect(result.charts.autonomyTrend).toEqual(AUTONOMY);
  });

  it("fills the trend when the cloud response carries an all-null trend", () => {
    const cloud = agents({ autonomyTrend: EMPTY_AUTONOMY });
    const local = agents({ autonomyTrend: AUTONOMY });

    const result = overlayLocalAutonomyTrend(cloud, local);

    expect(result.charts.autonomyTrend).toEqual(AUTONOMY);
  });

  it("preserves a populated cloud trend instead of overlaying local", () => {
    const cloudTrend: TimeSeries = {
      series: [{ key: "autonomy", label: "Autonomy" }],
      points: [{ date: "2026-07-05", values: { autonomy: 12 } }],
    };
    const cloud = agents({ autonomyTrend: cloudTrend });
    const local = agents({ autonomyTrend: AUTONOMY });

    const result = overlayLocalAutonomyTrend(cloud, local);

    expect(result.charts.autonomyTrend).toEqual(cloudTrend);
  });

  it("leaves the cloud response untouched when there is no local read", () => {
    const cloud = agents();

    const result = overlayLocalAutonomyTrend(cloud, undefined);

    expect(result.charts.autonomyTrend).toBeUndefined();
    expect(result).toBe(cloud);
  });

  it("leaves the cloud response untouched when the local trend is also all-null", () => {
    const cloud = agents();
    const local = agents({ autonomyTrend: EMPTY_AUTONOMY });

    const result = overlayLocalAutonomyTrend(cloud, local);

    expect(result.charts.autonomyTrend).toBeUndefined();
    expect(result).toBe(cloud);
  });

  it("does not mutate the input cloud response when overlaying", () => {
    const cloud = agents();
    const local = agents({ autonomyTrend: AUTONOMY });

    overlayLocalAutonomyTrend(cloud, local);

    expect(cloud.charts.autonomyTrend).toBeUndefined();
  });
});
