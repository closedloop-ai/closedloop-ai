import { DOCUMENT_METRIC_TREND_DAYS } from "@repo/api/src/types/document-list-summary";
import { describe, expect, it } from "vitest";
import { artifactMetricTrendlines } from "../artifact-summary";

const dates = {
  startDate: "2026-09-26T00:00:00.000Z",
  endDate: "2026-10-09T18:00:00.000Z",
};
const counts = Array.from(
  { length: DOCUMENT_METRIC_TREND_DAYS },
  (_, index) => index
);
const spend = counts.map((count, index) => (index === 2 ? null : count * 0.5));

describe("artifact metric trendlines", () => {
  it("maps production metric series without converting incomplete spend into zero", () => {
    const result = artifactMetricTrendlines(
      {
        total: 1,
        producedByAgentSessions: 1,
        updatedInWindow: 1,
        neverEdited: 0,
        windowDays: 7,
        trendlines: {
          ...dates,
          total: counts,
          producedByAgentSessions: counts,
          updatedInWindow: counts,
        },
      },
      {
        artifacts: [],
        trendlines: {
          ...dates,
          totalEstimatedCost: spend,
          medianEstimatedCost: spend,
        },
      }
    );
    expect(result.issues).toEqual(counts);
    expect(result.documents).toEqual(counts);
    expect(result["metric-four"]).toEqual(counts);
    expect(result["metric-five"]).toEqual(counts);
    expect(result["total-cost"]?.[2]).toBeNull();
    expect(result["median-cost"]?.[2]).toBeNull();
  });
  it("leaves a gap on a partial-coverage day rather than plot its measured-subset value (ISS-12599)", () => {
    const subset = counts.map((_, index) => (index === 2 ? 0.25 : null));
    const coverage = counts.map((_, index) => ({
      documentCount: 2,
      measuredDocumentCount: index === 2 ? 1 : 2,
      unknownDocumentCount: index === 2 ? 1 : 0,
    }));
    const result = artifactMetricTrendlines(undefined, {
      artifacts: [],
      trendlines: {
        ...dates,
        totalEstimatedCost: spend,
        medianEstimatedCost: spend,
        measuredSubsetTotalEstimatedCost: subset,
        measuredSubsetMedianEstimatedCost: subset,
        coverage,
      },
    });
    expect(result["total-cost"]).toEqual(spend);
    expect(result["median-cost"]).toEqual(spend);
    expect(result["total-cost"]?.[2]).toBeNull();
    expect(result["median-cost"]?.[2]).toBeNull();
  });
  it("omits absent or older-server series", () => {
    expect(
      Object.values(artifactMetricTrendlines()).every(
        (series) => series === undefined
      )
    ).toBe(true);
    expect(
      artifactMetricTrendlines(undefined, {
        artifacts: [],
        totalEstimatedCost: 0,
      })["total-cost"]
    ).toBeUndefined();
  });
});
