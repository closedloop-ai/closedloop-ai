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

  it("round-trips the range-scoped companion through both parsers", () => {
    // ISS-7363/ISS-7364: `z.object` STRIPS what it does not declare, so an
    // undeclared companion would survive the plain analytics read and vanish
    // only on this exact-cohort one — silently reverting the gated tiles to
    // their lifetime values precisely when a facet narrows the list.
    const response = windowScopedFixture();
    expect(
      branchAnalyticsCohortResponseSchema.parse(response).canonicalMetrics
        .windowScoped
    ).toEqual(response.canonicalMetrics.windowScoped);
    expect(
      branchAnalyticsCohortConsumerResponseSchema.parse(response)
        .canonicalMetrics.windowScoped
    ).toEqual(response.canonicalMetrics.windowScoped);
  });

  it("round-trips a metric's series through both parsers", () => {
    // ISS-10363 (whitlockk, tamsinb review on #7448): `series` was added to
    // `BranchListMetricValue` and not to the INNER value shape here, so the
    // exact-cohort parser stripped it. A filtered Branches request takes exactly
    // this path on both shells, so the mark drew on the unfiltered read and
    // vanished the moment a facet narrowed the list.
    const response = seriesFixture();
    const expected = [10, null, 30];
    expect(
      branchAnalyticsCohortResponseSchema.parse(response).canonicalMetrics
        .medianPrSize.series
    ).toEqual(expected);
    expect(
      branchAnalyticsCohortConsumerResponseSchema.parse(response)
        .canonicalMetrics.medianPrSize.series
    ).toEqual(expected);
  });

  it("accepts an older producer that omits the series", () => {
    expect(
      branchAnalyticsCohortResponseSchema.parse(responseFixture())
        .canonicalMetrics.medianPrSize.series
    ).toBeUndefined();
  });

  it("accepts an older producer that omits the range-scoped companion", () => {
    const legacy = responseFixture();
    expect(
      branchAnalyticsCohortResponseSchema.parse(legacy).canonicalMetrics
        .windowScoped
    ).toBeUndefined();
  });

  it("holds the strict/consumer split INSIDE the range-scoped companion", () => {
    // The nested companion is version-skewed on its own account: the sibling
    // test above proves only that a KNOWN companion survives. A newer producer
    // emitting a future state inside it must still be rejected by the producer
    // parser and degraded — not dropped, and not passed through opaque — by the
    // installed-client one, exactly as a top-level metric is.
    const response = windowScopedFixture();
    const skewed = {
      ...response,
      canonicalMetrics: {
        ...response.canonicalMetrics,
        windowScoped: {
          ...response.canonicalMetrics.windowScoped,
          activeBranches: { current: { state: "future_pending", value: 201 } },
        },
      },
    };

    expect(branchAnalyticsCohortResponseSchema.safeParse(skewed).success).toBe(
      false
    );
    expect(
      branchAnalyticsCohortConsumerResponseSchema.parse(skewed).canonicalMetrics
        .windowScoped
    ).toEqual({
      activeBranches: {
        current: { state: BranchMetricAvailability.Unavailable, value: null },
      },
      // The untouched sibling still carries its own value through the degrade.
      aiSpendUsd: {
        current: { state: BranchMetricAvailability.Complete, value: 0 },
      },
    });
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
            disclosure: BranchMetricDisclosure.PrIncomplete,
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

function seriesFixture() {
  const response = responseFixture();
  return {
    ...response,
    canonicalMetrics: {
      ...response.canonicalMetrics,
      // A gap rides the wire as `null`, which is the whole contract: a bucket
      // the producer could not compute must not arrive as a measured zero.
      medianPrSize: {
        ...response.canonicalMetrics.medianPrSize,
        series: [10, null, 30],
      },
    },
  };
}

function windowScopedFixture() {
  const complete = (value: number) => ({
    current: { state: BranchMetricAvailability.Complete, value } as const,
  });
  const response = responseFixture();
  return {
    ...response,
    canonicalMetrics: {
      ...response.canonicalMetrics,
      windowScoped: { activeBranches: complete(201), aiSpendUsd: complete(0) },
    },
  };
}

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
