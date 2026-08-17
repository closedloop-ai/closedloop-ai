import { describe, expect, it } from "vitest";
import {
  BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES,
  branchAnalyticsCohortConsumerResponseSchema,
  branchAnalyticsCohortRequestSchema,
  branchAnalyticsCohortResponseSchema,
} from "./branch-analytics-cohort";
import { makeOversizedBranchIds } from "./branch-analytics-cohort-fixtures.test-helpers";
import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "./branch-metrics";

const START = "2026-07-01T00:00:00.000Z";
const END_7D = "2026-07-08T00:00:00.000Z";
const END_INCLUSIVE_7D = "2026-07-07T23:59:59.999Z";

describe("branchAnalyticsCohortRequestSchema", () => {
  it("normalizes unique IDs and accepts All or exact fixed windows", () => {
    expect(
      branchAnalyticsCohortRequestSchema.parse({ branchIds: [" branch-1 "] })
    ).toEqual({ branchIds: ["branch-1"] });
    expect(
      branchAnalyticsCohortRequestSchema.parse({
        branchIds: ["branch-1"],
        startDate: START,
        endDate: END_7D,
      })
    ).toEqual({ branchIds: ["branch-1"], startDate: START, endDate: END_7D });
    expect(
      branchAnalyticsCohortRequestSchema.parse({
        branchIds: ["branch-1"],
        startDate: START,
        endDate: END_INCLUSIVE_7D,
      })
    ).toEqual({
      branchIds: ["branch-1"],
      startDate: START,
      endDate: END_INCLUSIVE_7D,
    });
  });

  it("accepts 101 unique identities within the transport budget", () => {
    const branchIds = makeBranchIds(101);

    expect(
      branchAnalyticsCohortRequestSchema.parse({ branchIds }).branchIds
    ).toEqual(branchIds);
  });

  it("rejects a serialized request above the shared transport budget", () => {
    const branchIds = makeOversizedBranchIds();
    const request = { branchIds };

    expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBe(
      BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES + 1
    );
    expect(branchIds.every((branchId) => branchId.length <= 512)).toBe(true);
    expect(branchAnalyticsCohortRequestSchema.safeParse(request).success).toBe(
      false
    );
  });

  it("budgets raw identities before whitespace normalization", () => {
    const branchIds = Array.from(
      { length: 140 },
      (_, index) => `${" ".repeat(480)}branch-${index}`
    );
    const request = { branchIds };
    const normalizedRequest = {
      branchIds: branchIds.map((branchId) => branchId.trim()),
    };

    expect(
      new TextEncoder().encode(JSON.stringify(request)).byteLength
    ).toBeGreaterThan(BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES);
    expect(
      new TextEncoder().encode(JSON.stringify(normalizedRequest)).byteLength
    ).toBeLessThan(BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES);
    expect(branchAnalyticsCohortRequestSchema.safeParse(request).success).toBe(
      false
    );
  });

  it.each([
    { branchIds: [] },
    { branchIds: [" "] },
    { branchIds: ["branch-1", " branch-1 "] },
    { branchIds: ["branch-1"], startDate: START },
    {
      branchIds: ["branch-1"],
      startDate: new Date(START),
      endDate: new Date(END_7D),
    },
    { branchIds: ["branch-1"], startDate: "not-a-date", endDate: END_7D },
    {
      branchIds: ["branch-1"],
      startDate: "2026-07-01T01:00:00.000+01:00",
      endDate: "2026-07-08T01:00:00.000+01:00",
    },
    { branchIds: ["branch-1"], startDate: END_7D, endDate: START },
    { branchIds: ["branch-1"], startDate: START, endDate: START },
    {
      branchIds: ["branch-1"],
      startDate: START,
      endDate: "2026-07-09T00:00:00.000Z",
    },
    { branchIds: ["branch-1"], unknown: true },
  ])("rejects malformed or ambiguous request %#", (request) => {
    expect(branchAnalyticsCohortRequestSchema.safeParse(request).success).toBe(
      false
    );
  });
});

describe("branchAnalyticsCohortResponseSchema", () => {
  it("accepts an exact 101-identity response", () => {
    const matchedBranchIds = makeBranchIds(101);
    const response = responseFixture();

    expect(
      branchAnalyticsCohortResponseSchema.parse({
        ...response,
        matchedBranchIds,
        canonicalMetrics: {
          ...response.canonicalMetrics,
          cohortSize: matchedBranchIds.length,
        },
      }).matchedBranchIds
    ).toEqual(matchedBranchIds);
  });

  it("strips additive future fields while retaining the known response", () => {
    const response = responseFixture();
    expect(
      branchAnalyticsCohortResponseSchema.parse({
        ...response,
        futureEnvelope: true,
        canonicalMetrics: {
          ...response.canonicalMetrics,
          futureMetric: { retainedByNewerClients: true },
        },
      })
    ).toEqual(response);
  });

  it.each([
    {
      ...responseFixture(),
      matchedBranchIds: ["branch-1", "branch-1"],
      canonicalMetrics: {
        ...responseFixture().canonicalMetrics,
        cohortSize: 2,
      },
    },
    {
      ...responseFixture(),
      canonicalMetrics: {
        ...responseFixture().canonicalMetrics,
        cohortSize: 0,
      },
    },
    {
      ...responseFixture(),
      canonicalMetrics: {
        ...responseFixture().canonicalMetrics,
        medianPrSize: {
          current: {
            state: BranchMetricAvailability.Partial,
            value: 12,
            coverage: { included: 2, total: 1 },
            disclosure: BranchMetricDisclosure.DefaultIncomplete,
          },
        },
      },
    },
  ])("rejects inconsistent cohort completeness provenance %#", (response) => {
    expect(
      branchAnalyticsCohortResponseSchema.safeParse(response).success
    ).toBe(false);
  });

  it("keeps producer literals strict while older consumers degrade only future metric states", () => {
    const response = responseFixture();
    const versionSkewedResponse = {
      ...response,
      canonicalMetrics: {
        ...response.canonicalMetrics,
        lastActiveAt: { state: "future_pending", value: "opaque" },
        medianPrSize: {
          current: {
            state: BranchMetricAvailability.Partial,
            value: 12,
            coverage: { included: 1, total: 2 },
            disclosure: "A newer, more specific incomplete disclosure.",
          },
        },
      },
    };

    expect(
      branchAnalyticsCohortResponseSchema.safeParse(versionSkewedResponse)
        .success
    ).toBe(false);
    expect(
      branchAnalyticsCohortConsumerResponseSchema.parse(versionSkewedResponse)
    ).toEqual({
      ...response,
      canonicalMetrics: {
        ...response.canonicalMetrics,
        lastActiveAt: {
          state: BranchMetricAvailability.Unavailable,
          value: null,
        },
        medianPrSize: {
          current: {
            state: BranchMetricAvailability.Partial,
            value: 12,
            coverage: { included: 1, total: 2 },
            disclosure: BranchMetricDisclosure.DefaultIncomplete,
          },
        },
      },
    });
  });
});

function responseFixture() {
  const noData = {
    state: BranchMetricAvailability.NoData,
    value: null,
  } as const;
  const value = { current: noData };
  return {
    matchedBranchIds: ["branch-1"],
    canonicalMetrics: {
      period: BranchMetricPeriod.All,
      label: BranchMetricComparisonLabel.AllTime,
      window: { startAt: null, endAt: "2026-08-05T00:00:00.000Z" },
      cohortSize: 1,
      lastActiveAt: noData,
      activeBranches: value,
      locPerDollar: value,
      medianPrSize: value,
      aiSpendUsd: value,
      mergeRatePct: value,
    },
  };
}

function makeBranchIds(length: number) {
  return Array.from({ length }, (_, index) => `branch-${index}`);
}
