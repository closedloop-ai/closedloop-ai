import { InsightsTileAvailabilityState } from "@closedloop-ai/loops-api/insights";
import { describe, expect, it } from "vitest";
import { buildDeliveryTileAvailability } from "../src/main/database/local-insights-tiles.js";

describe("buildDeliveryTileAvailability", () => {
  const map = buildDeliveryTileAvailability({
    hasDecidedPrCohort: false,
    hasTtmEvidence: true,
  });

  it.each([
    "chart:prByRepo",
    "chart:prByRepo:donut",
    "chart:prByState",
    "chart:prByState:donut",
    "kpi:merge-rate",
  ])("reports %s Unavailable", (tileId) => {
    expect(map[tileId]).toBe(InsightsTileAvailabilityState.Unavailable);
  });

  it("keeps the transcript-derived Captured PRs tile Available", () => {
    expect(map["kpi:merged"]).toBe(InsightsTileAvailabilityState.Available);
  });
});
