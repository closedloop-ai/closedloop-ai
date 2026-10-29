import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import { InsightsGitHubProvenanceState } from "@repo/api/src/types/insights";
import { describe, expect, it } from "vitest";
import { getSectionGitHubProvenance } from "../github-provenance";

const EMPTY_TIME_SERIES = { series: [], points: [] };

const deliveryWithProvenance: DeliveryInsightsResponse = {
  kpis: [],
  githubProvenance: {
    state: InsightsGitHubProvenanceState.Active,
    checkedAt: "2026-09-04T00:00:00.000Z",
  },
  charts: {
    prTrend: EMPTY_TIME_SERIES,
    prByRepo: [],
    meanTimeToMerge: [],
    prByState: [],
    branchLifespan: [],
    branchesWithoutPr: [],
  },
};

const utilizationWithoutProvenance: UtilizationInsightsResponse = {
  kpis: [],
  charts: {
    eventActivity: EMPTY_TIME_SERIES,
    reviewQueue: [],
  },
};

const agentsResponse: AgentsInsightsResponse = {
  kpis: [],
  charts: {
    modelUsageOverTime: EMPTY_TIME_SERIES,
    modelBreakdown: [],
  },
};

describe("getSectionGitHubProvenance", () => {
  it("returns undefined for an undefined section", () => {
    expect(getSectionGitHubProvenance(undefined)).toBeUndefined();
  });

  it("returns undefined when the section has no githubProvenance property", () => {
    expect(
      getSectionGitHubProvenance(utilizationWithoutProvenance)
    ).toBeUndefined();
  });

  it("returns undefined for a section type that never carries githubProvenance", () => {
    expect(getSectionGitHubProvenance(agentsResponse)).toBeUndefined();
  });

  it("returns the provenance when the section carries one", () => {
    expect(getSectionGitHubProvenance(deliveryWithProvenance)).toEqual({
      state: InsightsGitHubProvenanceState.Active,
      checkedAt: "2026-09-04T00:00:00.000Z",
    });
  });
});
