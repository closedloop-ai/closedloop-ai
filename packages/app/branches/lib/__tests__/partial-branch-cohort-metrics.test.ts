/**
 * @file partial-branch-cohort-metrics.test.ts
 * @description ISS-8968 — a producer answer covering a SUBSET of the requested
 * cohort is published as Partial, not discarded.
 *
 * The producer narrows the requested identities twice (authorized candidates,
 * then those projecting an analytics row) and computes its metrics over exactly
 * what survived. `selectExactBranchCohortMetrics` demands set equality, so one
 * declined branch out of many blanked LOC per $, Median PR size and Merge rate
 * together — discarding figures that were correct for a cohort we can name.
 *
 * The line that matters is SMALLER versus WRONG: a strictly smaller matched set
 * is ours minus what the producer declined; a matched identity we never asked
 * for describes some other cohort and stays rejected.
 */
import {
  type BranchAnalytics,
  BranchKpiState,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import type { BranchAnalyticsCohortRequest } from "@repo/api/src/types/branch-analytics-cohort";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  bindApprovedBranchCohortAnalyticsOverFilteredRows,
  bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort,
  selectPartialBranchCohortMetrics,
} from "../approved-branch-cohort";
import { bindCanonicalMetricsToFilteredRows } from "../approved-filtered-metrics";
import { DEFAULT_BRANCH_FILTERS } from "../branch-row";
import { unavailableKpi, wireRow } from "./approved-branch-fixtures";

const OWNER_FILTER = {
  ...DEFAULT_BRANCH_FILTERS,
  owners: ["github:daveth"],
};

describe("selectPartialBranchCohortMetrics", () => {
  it("accepts a strictly smaller matched set and reports its coverage", () => {
    const result = selectPartialBranchCohortMetrics(
      request(["branch-1", "branch-2", "branch-3"]),
      response(["branch-1", "branch-2"], 4.05)
    );

    expect(result?.coverage).toEqual({ included: 2, total: 3 });
    expect(result?.metrics.locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 4.05,
    });
  });

  it("declines an exact match, which is the exact selector's answer to give", () => {
    expect(
      selectPartialBranchCohortMetrics(
        request(["branch-1", "branch-2"]),
        response(["branch-1", "branch-2"], 4.05)
      )
    ).toBeNull();
  });

  it("declines an empty matched set — nothing was covered", () => {
    expect(
      selectPartialBranchCohortMetrics(
        request(["branch-1", "branch-2"]),
        response([], 4.05)
      )
    ).toBeNull();
  });

  it("declines a matched identity that was never requested — a different cohort, not a smaller one", () => {
    expect(
      selectPartialBranchCohortMetrics(
        request(["branch-1", "branch-2", "branch-3"]),
        response(["branch-1", "branch-9"], 4.05)
      )
    ).toBeNull();
  });

  it("declines a duplicated request identity, which makes both counts unreliable", () => {
    expect(
      selectPartialBranchCohortMetrics(
        request(["branch-1", "branch-1", "branch-2"]),
        response(["branch-1"], 4.05)
      )
    ).toBeNull();
  });

  /**
   * The mirror of the case above, on the RESPONSE side. The wire schema already
   * rejects a duplicated `matchedBranchIds`, but this selector also accepts the
   * desktop-local response and is written to be independently defensive — and
   * without this case, deleting that clause leaves the suite green while a
   * duplicated identity inflates `coverage.included` in the rendered star.
   */
  it("declines a duplicated matched identity, which inflates the coverage it reports", () => {
    expect(
      selectPartialBranchCohortMetrics(
        request(["branch-1", "branch-2", "branch-3"]),
        response(["branch-1", "branch-1"], 4.05)
      )
    ).toBeNull();
  });
});

describe("bindCanonicalMetricsToFilteredRows with a partial cohort", () => {
  it("publishes the three fields as Partial with coverage and a disclosure", () => {
    const rows = [wireRow()];

    const result = bindCanonicalMetricsToFilteredRows(
      canonicalAnalytics(),
      rows,
      OWNER_FILTER,
      { session1: 3.5 },
      [...rows, wireRow({ id: "branch-2" })],
      {
        coverage: { included: 2, total: 3 },
        metrics: metricBundle(4.05),
      }
    );

    const metrics = result.canonicalMetrics;
    expect(metrics?.locPerDollar.current).toEqual({
      coverage: { included: 2, total: 3 },
      disclosure: BranchMetricDisclosure.BranchesIncomplete,
      state: BranchMetricAvailability.Partial,
      value: 4.05,
    });
    expect(metrics?.medianPrSize.current.state).toBe(
      BranchMetricAvailability.Partial
    );
    expect(metrics?.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("still fails closed to Unavailable when no partial answer is supplied", () => {
    const rows = [wireRow()];

    const result = bindCanonicalMetricsToFilteredRows(
      canonicalAnalytics(),
      rows,
      OWNER_FILTER,
      { session1: 3.5 },
      [...rows, wireRow({ id: "branch-2" })]
    );

    expect(result.canonicalMetrics?.locPerDollar.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("does not make an unavailable producer value available", () => {
    const rows = [wireRow()];
    const bundle = metricBundle(4.05);

    const result = bindCanonicalMetricsToFilteredRows(
      canonicalAnalytics(),
      rows,
      OWNER_FILTER,
      { session1: 3.5 },
      [...rows, wireRow({ id: "branch-2" })],
      {
        coverage: { included: 2, total: 3 },
        metrics: {
          ...bundle,
          locPerDollar: {
            current: {
              state: BranchMetricAvailability.Unavailable,
              value: null,
            },
          },
        },
      }
    );

    expect(result.canonicalMetrics?.locPerDollar.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });
});

/**
 * ISS-10734 repoint. These cases drove the retired fail-closed pair; they now
 * drive the `...OverFilteredRows` pair every host actually selects.
 *
 * The two fallbacks are NOT interchangeable — `RECOMPUTE_FALLBACK` re-derives
 * `medianPrSize` and `mergeRatePct` over the filtered rows, keeps the session
 * cost map once a cohort was requested, and never sets
 * `comparisonSuppressedByFilter` — so the repoint was checked case by case. It
 * is sound here because every case below asserts on `locPerDollar` /
 * `canonicalLocPerDollar`, which NEITHER fallback re-derives (no row-provable
 * form), or takes the same-rows republish branch that returns before any
 * fallback runs at all.
 */
describe("bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort wiring", () => {
  /**
   * Review (marisolashgrove): the caller is the line that actually ships the fix,
   * and deleting its argument left every other test green. This drives the real
   * entry point with a strict-subset response so that line is pinned.
   */
  it("carries a strict-subset producer answer through to a Partial card value", () => {
    const rows = [wireRow(), wireRow({ id: "branch-2" })];

    const bound =
      bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort({
        analytics: canonicalAnalytics(),
        filteredRows: rows,
        filters: OWNER_FILTER,
        request: request(["branch-1", "branch-2"]),
        response: response(["branch-1"], 4.05),
        unfilteredRows: [...rows, wireRow({ id: "branch-3" })],
      });

    expect(bound.analytics?.canonicalMetrics?.locPerDollar.current).toEqual({
      coverage: { included: 1, total: 2 },
      disclosure: BranchMetricDisclosure.BranchesIncomplete,
      state: BranchMetricAvailability.Partial,
      value: 4.05,
    });
  });

  it("leaves the card unavailable when the producer answered for a different cohort", () => {
    const rows = [wireRow(), wireRow({ id: "branch-2" })];

    const bound =
      bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort({
        analytics: canonicalAnalytics(),
        filteredRows: rows,
        filters: OWNER_FILTER,
        request: request(["branch-1", "branch-2"]),
        response: response(["branch-9"], 4.05),
        unfilteredRows: [...rows, wireRow({ id: "branch-3" })],
      });

    expect(bound.analytics?.canonicalMetrics?.locPerDollar.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  /**
   * ISS-8968 (ISS-4779 closed-by-default policy): the two entry points ARE the
   * flag, so this is the gate's only mechanical proof. Point either surface's
   * flag-off branch at the partial-cohort entry and this reddens; without it the
   * gate is a line nothing holds to its promise.
   */
  it("fails closed on the same input through the flag-off entry point", () => {
    const rows = [wireRow(), wireRow({ id: "branch-2" })];
    const input = {
      analytics: canonicalAnalytics(),
      filteredRows: rows,
      filters: OWNER_FILTER,
      request: request(["branch-1", "branch-2"]),
      response: response(["branch-1"], 4.05),
      unfilteredRows: [...rows, wireRow({ id: "branch-3" })],
    };

    expect(
      bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort(input)
        .analytics?.canonicalMetrics?.locPerDollar.current.state
    ).toBe(BranchMetricAvailability.Partial);
    expect(
      bindApprovedBranchCohortAnalyticsOverFilteredRows(input).analytics
        ?.canonicalMetrics?.locPerDollar.current.state
    ).toBe(BranchMetricAvailability.Unavailable);
  });
});

/**
 * ISS-10734 repoint, on the same reasoning as the block above: these cases were
 * written against the retired fail-closed binder and now drive the
 * `...OverFilteredRows` pair. Every one of them either asserts on `locPerDollar`
 * / `canonicalLocPerDollar`, which neither fallback re-derives, or passes
 * `unfilteredRows: rows` and so takes the same-rows republish branch that
 * returns before the fallback runs.
 */
describe("producer provenance under a partial cohort", () => {
  /**
   * Review (whitlockk): the producer's coverage describes ITS evidence, so
   * restamping it with the cohort's branch counts would claim coverage the
   * metric never had. It is still preserved verbatim.
   *
   * The DISCLOSURE deliberately changes: one result carries one sentence, and
   * keeping the producer's alone told the reader which pull requests were short
   * while never mentioning that a whole branch was missing from the population.
   * `BranchesAndEvidenceIncomplete` names both narrowings, which is what R8
   * asks for and what the earlier revision of this test did not deliver.
   */
  it("keeps a producer's Partial coverage but discloses both narrowings", () => {
    const rows = [wireRow()];
    const producerPartial = {
      coverage: { included: 1, total: 2 },
      disclosure: BranchMetricDisclosure.PrIncomplete,
      state: BranchMetricAvailability.Partial,
      value: 42,
    } as const;

    const result = bindCanonicalMetricsToFilteredRows(
      canonicalAnalytics(),
      rows,
      OWNER_FILTER,
      { session1: 3.5 },
      [...rows, wireRow({ id: "branch-2" })],
      {
        coverage: { included: 2, total: 3 },
        metrics: {
          ...metricBundle(4.05),
          medianPrSize: { current: producerPartial },
        },
      }
    );

    // Whole-object, so the coverage stays the producer's own 1-of-2 rather than
    // the cohort's 2-of-3 — a restamp fails here.
    expect(result.canonicalMetrics?.medianPrSize.current).toEqual({
      ...producerPartial,
      disclosure: BranchMetricDisclosure.BranchesAndEvidenceIncomplete,
    });
  });

  /**
   * BEHAVIOUR CHANGE, deliberate. An earlier revision passed `NotApplicable`
   * through, answering an objection (marisolashgrove) to taking the producer's
   * NUMBER while overruling its verdict. This takes neither.
   *
   * `NotApplicable` is a claim about a POPULATION, and the producer made it
   * about the subset it matched: "no decided PRs" across 2 of 3 branches does
   * not establish that the third has none. `BranchMetricResult` gives the
   * verdict states no `coverage` and no `disclosure`, so there is no way to
   * publish one qualified — it renders as a bare "N/A" asserting the whole
   * selection, which is a more confident claim than the pre-ISS-8968 code made.
   */
  it("declines a NotApplicable verdict measured over a different population", () => {
    const rows = [wireRow()];

    const result = bindCanonicalMetricsToFilteredRows(
      canonicalAnalytics(),
      rows,
      OWNER_FILTER,
      { session1: 3.5 },
      [...rows, wireRow({ id: "branch-2" })],
      {
        coverage: { included: 2, total: 3 },
        metrics: {
          ...metricBundle(4.05),
          mergeRatePct: {
            current: {
              state: BranchMetricAvailability.NotApplicable,
              value: null,
            },
          },
        },
      }
    );

    expect(result.canonicalMetrics?.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("declines a NoData verdict for the same reason", () => {
    const rows = [wireRow()];

    const result = bindCanonicalMetricsToFilteredRows(
      canonicalAnalytics(),
      rows,
      OWNER_FILTER,
      { session1: 3.5 },
      [...rows, wireRow({ id: "branch-2" })],
      {
        coverage: { included: 2, total: 3 },
        metrics: {
          ...metricBundle(4.05),
          medianPrSize: {
            current: { state: BranchMetricAvailability.NoData, value: null },
          },
        },
      }
    );

    expect(result.canonicalMetrics?.medianPrSize.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  /**
   * Review (davetho): an active facet can leave the loaded rows unchanged
   * while the producer still declines a branch. Driven through the production
   * entry point rather than the inner binder, so the `sessionCostUsd` handed in
   * is the one production would hand in and the "nothing else may move"
   * assertions are read against a real spend figure rather than an absent one.
   */
  it("republishes only the cohort-sourced metrics when the facet removed no rows", () => {
    const rows = [wireRow(), wireRow({ id: "branch-2" })];
    const producer = canonicalAnalytics();

    const bound =
      bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort({
        analytics: producer,
        filteredRows: rows,
        filters: OWNER_FILTER,
        request: request(["branch-1", "branch-2"]),
        response: response(["branch-1"], 4.05),
        sessionCostUsd: { session1: 3.5 },
        unfilteredRows: rows,
      });
    const metrics = bound.analytics?.canonicalMetrics;

    expect(metrics?.locPerDollar.current.state).toBe(
      BranchMetricAvailability.Partial
    );
    // The rows did not narrow, so nothing else may move.
    expect(metrics?.aiSpendUsd).toEqual(producer.canonicalMetrics?.aiSpendUsd);
    expect(metrics?.activeBranches).toEqual(
      producer.canonicalMetrics?.activeBranches
    );
    expect(metrics?.cohortSize).toBe(producer.canonicalMetrics?.cohortSize);
    expect(bound.comparisonSuppressedByFilter).toBe(false);
  });

  /**
   * ISS-10636: this same-rows path republished `locPerDollar`, `medianPrSize`
   * and `mergeRatePct` from the cohort but NOT `canonicalLocPerDollar` — so
   * once the retirement made the LOC per $ card read that field, the card
   * reported the WHOLE LIST beside two rowmates reporting the matched subset.
   * That is the defect `republishPartialCohortMetrics`' own note says was
   * closed for `totalLocPushed` and `pushedLocPerDollar`; this was the third.
   *
   * `unfilteredRows: rows` is load-bearing — it is what makes `sameRowCohort`
   * true and routes this through `republishPartialCohortMetrics`. With rows
   * that DID narrow, the recompute fallback handles the field correctly
   * already and the assertion below passes on the defect.
   *
   * Asserted as a pair against the whole-list value: `canonicalAnalytics()`
   * publishes 1 and the cohort answers 4.05, so a card still reading the whole
   * list fails on the VALUE, not merely on the state.
   */
  it("republishes the canonical ratio the card reads, not only the legacy one", () => {
    const rows = [wireRow(), wireRow({ id: "branch-2" })];

    const bound =
      bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort({
        analytics: canonicalAnalytics(),
        filteredRows: rows,
        filters: OWNER_FILTER,
        request: request(["branch-1", "branch-2"]),
        response: response(["branch-1"], 4.05),
        unfilteredRows: rows,
      });

    const expected = {
      coverage: { included: 1, total: 2 },
      disclosure: BranchMetricDisclosure.BranchesIncomplete,
      state: BranchMetricAvailability.Partial,
      value: 4.05,
    };
    expect(
      bound.analytics?.canonicalMetrics?.canonicalLocPerDollar?.current
    ).toEqual(expected);
    expect(bound.analytics?.canonicalMetrics?.locPerDollar.current).toEqual(
      expected
    );
  });

  /**
   * Review (bha_p0_f0/bhb_f0): routing a DECLINED metric through
   * `replaceCurrent` kept its value and blanked its `deltaPct` — the same
   * "blank a comparison the filter did not narrow" defect the same-rows path
   * exists to prevent, one metric wide. The earlier fixture carried no
   * `comparison` at all, so the blanking branch was unreachable and the
   * assertion that "nothing else may move" could not see it.
   *
   * The two Bug Hunters disagreed on the remedy: one said keep the producer's
   * value untouched, the other said fail closed to Unavailable like the sibling
   * binder does. Untouched is right HERE and only here — the rows did not
   * narrow, so the whole-list figure already describes this exact selection.
   */
  it("leaves a declined metric wholly untouched, comparison included", () => {
    const rows = [wireRow(), wireRow({ id: "branch-2" })];
    const producer = canonicalAnalytics();
    const withDelta = {
      comparison: {
        deltaPct: { state: BranchMetricAvailability.Complete, value: 12 },
        label: BranchMetricComparisonLabel.WeekOverWeek,
        priorWindow: PRIOR_WINDOW,
      },
      current: { state: BranchMetricAvailability.Complete, value: 7 },
    } as const;
    if (producer.canonicalMetrics) {
      producer.canonicalMetrics.mergeRatePct = withDelta;
    }

    const bound =
      bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort({
        analytics: producer,
        filteredRows: rows,
        filters: OWNER_FILTER,
        request: request(["branch-1", "branch-2"]),
        response: declinedMergeRateResponse(["branch-1"], 4.05),
        unfilteredRows: rows,
      });
    const metrics = bound.analytics?.canonicalMetrics;

    // The cohort declined this one, so it keeps its value AND its delta.
    expect(metrics?.mergeRatePct).toEqual(withDelta);
    // The one it did measure is republished, and loses its delta by design.
    expect(metrics?.locPerDollar.current.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("still narrows the whole bundle when the facet did remove a row", () => {
    const rows = [wireRow(), wireRow({ id: "branch-2" })];

    const bound =
      bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort({
        analytics: canonicalAnalytics(),
        filteredRows: rows,
        filters: OWNER_FILTER,
        request: request(["branch-1", "branch-2"]),
        response: response(["branch-1"], 4.05),
        sessionCostUsd: { session1: 3.5 },
        unfilteredRows: [...rows, wireRow({ id: "branch-3" })],
      });
    const metrics = bound.analytics?.canonicalMetrics;

    expect(metrics?.locPerDollar.current.state).toBe(
      BranchMetricAvailability.Partial
    );
    // The producer sent all four of these as Complete at 1. Each is re-derived
    // over the two rows on screen — the narrowing this case is named for, and
    // the half the retired fail-closed fallback used to blank instead.
    expect(metrics?.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 3.5,
    });
    expect(metrics?.activeBranches.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 2,
    });
    expect(metrics?.medianPrSize.current).toEqual({
      state: BranchMetricAvailability.NotApplicable,
      value: null,
    });
    expect(metrics?.mergeRatePct.current).toEqual({
      state: BranchMetricAvailability.NotApplicable,
      value: null,
    });
  });
});

function request(branchIds: string[]): BranchAnalyticsCohortRequest {
  return { branchIds };
}

function response(matchedBranchIds: string[], locPerDollar: number) {
  return {
    canonicalMetrics: {
      ...metricBundle(locPerDollar),
      cohortSize: matchedBranchIds.length,
    },
    matchedBranchIds,
  };
}

/** A prior window the fixture bundle can carry a real delta against. */
const PRIOR_WINDOW = {
  endAt: "2026-07-06T00:00:00.000Z",
  startAt: "2026-06-06T00:00:00.000Z",
} as const;

/** A partial cohort that measured `locPerDollar` and declined `mergeRatePct`. */
function declinedMergeRateResponse(
  matchedBranchIds: string[],
  locPerDollar: number
) {
  const bundle = metricBundle(locPerDollar);
  return {
    canonicalMetrics: {
      ...bundle,
      cohortSize: matchedBranchIds.length,
      mergeRatePct: {
        current: {
          state: BranchMetricAvailability.NotApplicable,
          value: null,
        },
      },
    },
    matchedBranchIds,
  };
}

function metricBundle(locPerDollar: number): BranchListMetricBundle {
  const metric = {
    current: { state: BranchMetricAvailability.Complete, value: 1 } as const,
  };
  return {
    activeBranches: metric,
    aiSpendUsd: metric,
    cohortSize: 2,
    label: BranchMetricComparisonLabel.MonthOverMonth,
    lastActiveAt: {
      state: BranchMetricAvailability.Complete,
      value: "2026-08-05T12:00:00.000Z",
    },
    // The field the LOC per $ card READS since ISS-10636 retired the gate, and
    // the one every producer emits. Carried beside `locPerDollar` rather than
    // instead of it: the legacy field is still what the ISS-9732 tile divides,
    // and the two are asserted separately below.
    canonicalLocPerDollar: {
      current: {
        state: BranchMetricAvailability.Complete,
        value: locPerDollar,
      },
    },
    locPerDollar: {
      current: {
        state: BranchMetricAvailability.Complete,
        value: locPerDollar,
      },
    },
    medianPrSize: metric,
    mergeRatePct: metric,
    period: BranchMetricPeriod.ThirtyDays,
    window: {
      endAt: "2026-08-05T00:00:00.000Z",
      startAt: "2026-07-06T00:00:00.000Z",
    },
  };
}

function canonicalAnalytics(): BranchAnalytics {
  return {
    activeBranchCount: unavailableKpi(),
    activePrCount: unavailableKpi(),
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: BranchKpiState.Unavailable,
    },
    canonicalMetrics: metricBundle(1),
    leadTimeForChangeMs: unavailableKpi(),
    locPerDollar: unavailableKpi(),
    medianPrSize: unavailableKpi(),
    medianTimeToMergeMs: unavailableKpi(),
    mergeRate: unavailableKpi(),
    mergedCount: unavailableKpi(),
    totalSpendUsd: unavailableKpi(),
    viewerScope: BranchViewerScope.Self,
  };
}
