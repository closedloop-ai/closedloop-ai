/**
 * @file cohort-loc-per-dollar-population.test.ts
 * @description ISS-9751 — the Agents cohort LOC/$ must sum its numerator and its
 * denominator over ONE population.
 *
 * `sumScalars` coerced an unpriced `estimatedCost` to `$0`, so an unpriced
 * session's lines entered the numerator while its cost never entered the
 * denominator, and the ratio rose with every session the pricing pipeline could
 * not reach. The baseline half had the same hole from the other side: `_sum`
 * skips nulls, so its denominator covered only the priced rows while
 * `computeDedupedBaselineLoc` folded every row into the numerator.
 *
 * The load-bearing case is PARTIAL coverage. A fully priced cohort reconciles
 * whatever the code does, so it can only ever prove the fix did not hide
 * everything — which is why it is asserted here beside the partial one rather
 * than instead of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `computeCohortPerformance` reaches `Prisma.sql` through `cohort-baseline-loc`;
// mock the builder so the fake db can accept a raw query without a real client.
vi.mock("@repo/database", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (values: unknown[]) => ({ values }),
  },
  withDb: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { log } from "@repo/observability/log";
import {
  type FakeAggregateQuery,
  type FakeBaselineSum,
  type FakeCountQuery,
  makeFakeDb,
  ORG,
  row,
} from "@/__tests__/support/agent-components/cohort-performance.test-db";
import {
  CORRUPT_COHORT_METRIC_EVENT,
  CohortMetricScope,
} from "../cohort-metric-integrity";
import { computeCohortPerformance } from "../cohort-performance";

/**
 * A fully priced baseline: 2,000 lines for $2 — 1,000 LOC/$. Every case below
 * takes its delta against this one figure, so a delta is only ever a statement
 * about the COHORT's ratio.
 */
const PRICED_BASELINE: FakeBaselineSum = {
  linesAdded: 2000,
  linesRemoved: 0,
  estimatedCost: 2,
  inputTokens: 2000n,
  outputTokens: 2000n,
};

describe("ISS-9751 cohort LOC/$ spans one population", () => {
  beforeEach(() => vi.clearAllMocks());

  it("publishes no ratio when one cohort session is unpriced", async () => {
    const db = makeFakeDb({
      // 8,000 lines across two sessions, only $2 of which is priced. The
      // all-rows-over-priced-rows division reads 8000/2 = 4,000 LOC/$ against a
      // 1,000 LOC/$ baseline and renders +300%; the honest answer is that there
      // is no rate here at all.
      cohortRows: [
        row({ id: "s1", loc: 4000, cost: 2, tokens: 4000 }),
        row({ id: "s2", loc: 4000, cost: null, tokens: 4000 }),
      ],
      baselineSum: PRICED_BASELINE,
    });

    const result = await computeCohortPerformance(db, ORG, ["s1", "s2"], {
      cohortSampled: false,
    });

    expect(result.locDelta).toBeNull();
    // Only the LOC/$ arm is suppressed. Every row in THIS fixture has measured
    // lines and measured tokens, so the token-efficiency delta is genuinely
    // computable — a null here would mean the fix took out the card rather than
    // the one wrong number. (It is not a claim that `tokensPerLoc` carries a
    // coverage verdict of its own; it does not, and that is out of scope here.)
    expect(result.tokenEfficiencyDelta).not.toBeNull();
  });

  it("publishes the ratio when every cohort session is priced", async () => {
    const db = makeFakeDb({
      // The same 8,000 lines, now with the whole $4 measured → 2,000 LOC/$
      // against the 1,000 LOC/$ baseline.
      cohortRows: [
        row({ id: "s1", loc: 4000, cost: 2, tokens: 4000 }),
        row({ id: "s2", loc: 4000, cost: 2, tokens: 4000 }),
      ],
      baselineSum: PRICED_BASELINE,
    });

    const result = await computeCohortPerformance(db, ORG, ["s1", "s2"], {
      cohortSampled: false,
    });

    expect(result.locDelta).toBe(100);
  });

  it("treats a negative stored cost as unpriced, not as a discount", async () => {
    // The column is a plain nullable `Decimal`, so a negative is reachable from
    // a corrupt write even though the ingest never makes one. The owner's fold
    // calls it unmeasured; the surface must not disagree by summing it.
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s1", loc: 4000, cost: 2, tokens: 4000 }),
        row({ id: "s2", loc: 4000, cost: -1, tokens: 4000 }),
      ],
      baselineSum: PRICED_BASELINE,
    });

    const result = await computeCohortPerformance(db, ORG, ["s1", "s2"], {
      cohortSampled: false,
    });

    expect(result.locDelta).toBeNull();
  });

  // These next three are one contract in three parts: a zero LOC/$ is publishable
  // only when the zero is VERIFIED, which is the owner's own word. They have to
  // sit together — the pair of identical-looking `0` folds is what proves the
  // code tells a measured zero from an unmeasured one, and either alone does not.
  it("publishes no ratio when the cohort's lines were never measured", async () => {
    // `linesAdded`/`linesRemoved` are `Int?` and `sessionLoc` folds a missing
    // count to 0, so this cohort reaches the divider looking exactly like the
    // verified-zero one below. Publishing it would assert "$2 spent, nothing
    // delivered" about a cohort nobody ever measured — a fabricated -100%.
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1", loc: null, cost: 2, tokens: 4000 })],
      baselineSum: PRICED_BASELINE,
    });

    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });

    expect(result.locDelta).toBeNull();
  });

  it("treats one present count and one null count as unmeasured", async () => {
    // Measured is BOTH counts present — the AND `isLocEnriched` canonizes. This
    // asymmetric row is the only fixture that tells that rule apart from a
    // both-null one, so without it the AND could be relaxed with nothing red.
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s1", loc: 0, locRemoved: null, cost: 2, tokens: 4000 }),
      ],
      baselineSum: PRICED_BASELINE,
    });

    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });

    expect(result.locDelta).toBeNull();
  });

  it("renders a verified zero rather than hiding it", async () => {
    // Both counts present and both zero: a priced cohort that VERIFIABLY shipped
    // no lines is a fact about the population — $2 spent, nothing delivered —
    // not an absence. -100% against the 1,000 LOC/$ baseline has to reach the card.
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1", loc: 0, cost: 2, tokens: 4000 })],
      baselineSum: PRICED_BASELINE,
    });

    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });

    expect(result.locDelta).toBe(-100);
  });

  it("still publishes when a positive fold contains an unmeasured row", async () => {
    // The narrow guard's boundary, and the reason it is narrow. A positive fold
    // cannot be the fabricated zero above, so it publishes. Suppressing here
    // would blank the delta for any cohort holding one un-enriched session — the
    // common case. That the two terms are asymmetric about measuredness is the
    // recorded decision, not a deferral; `sumScalars` carries the reasoning.
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s1", loc: 8000, cost: 2, tokens: 4000 }),
        row({ id: "s2", loc: null, cost: 2, tokens: 4000 }),
      ],
      baselineSum: PRICED_BASELINE,
    });

    const result = await computeCohortPerformance(db, ORG, ["s1", "s2"], {
      cohortSampled: false,
    });

    // 8,000 lines over the measured $4 → 2,000 LOC/$ against a 1,000 baseline.
    expect(result.locDelta).toBe(100);
  });

  it("publishes no ratio when a baseline session is unpriced", async () => {
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1", loc: 4000, cost: 2, tokens: 4000 })],
      baselineSum: PRICED_BASELINE,
      // `_sum` skipped one row's null cost while the LOC fold counted its lines,
      // so the baseline's own two terms describe different populations.
      baselineCostCoverage: { rowCount: 3, pricedRows: 2 },
    });

    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });

    expect(result.locDelta).toBeNull();
    expect(result.tokenEfficiencyDelta).not.toBeNull();
  });

  it("publishes no ratio when a baseline cost is negative", async () => {
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1", loc: 4000, cost: 2, tokens: 4000 })],
      baselineSum: PRICED_BASELINE,
      // Every row priced, but one of them corruptly negative — `_sum` folded it
      // as a discount, so the denominator is not a cost over this population.
      baselineCostCoverage: {
        rowCount: 3,
        pricedRows: 3,
        minimumEstimatedCost: -1,
      },
    });

    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });

    expect(result.locDelta).toBeNull();
  });

  // whitlockk, #6878: the coverage verdict is the PROOF that the cost `_sum` and the
  // LOC fold cover the same rows, so it cannot be a second statement in a second
  // READ COMMITTED snapshot. These two cases are the fix: the verdict rides the
  // aggregate it certifies, and the retired second statement is never issued.
  it("keeps the baseline coverage verdict on the cost aggregate's own snapshot", async () => {
    const countQueries: FakeCountQuery[] = [];
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1", loc: 4000, cost: 2, tokens: 4000 })],
      baselineSum: PRICED_BASELINE,
      // The aggregate's snapshot: 3 rows, 2 priced. Its `_sum` denominator is
      // short one row's cost while the LOC fold counted that row's lines.
      baselineCostCoverage: { rowCount: 3, pricedRows: 2 },
      // The interleave. The pricing pipeline priced that row AFTER the aggregate
      // read it, so a separate statement now sees a fully priced window. This
      // zero is exactly what the two-statement form read, and reading it
      // certified complete coverage over the short denominator above —
      // publishing the mismatched ratio the guard exists to suppress.
      racingUnpricedCount: 0,
      countQueries,
    });

    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });

    expect(result.locDelta).toBeNull();
    expect(countQueries).toEqual([]);
  });

  it("reads the baseline coverage counters over the same scope as the cost sum", async () => {
    const aggregateQueries: FakeAggregateQuery[] = [];
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s1", loc: 4000, cost: 2, tokens: 4000, startedAt: 1000 }),
        row({ id: "s2", loc: 4000, cost: 2, tokens: 4000, startedAt: 5000 }),
      ],
      baselineSum: PRICED_BASELINE,
      aggregateQueries,
    });

    await computeCohortPerformance(db, ORG, ["s1", "s2"], {
      cohortSampled: false,
    });

    // The tokens/cost aggregate is the one without the `locSource` `OR` filter.
    const costAggregate = aggregateQueries.find((args) => !args.where?.OR);
    expect(costAggregate?._sum?.estimatedCost).toBe(true);
    // Same args object ⇒ same statement ⇒ same snapshot as the `_sum` above.
    expect(costAggregate?._count).toEqual({ _all: true, estimatedCost: true });
    expect(costAggregate?._min).toEqual({ estimatedCost: true });
  });

  // whitlockk, #6878: `isLocEnriched` only rules out nulls, so a corrupt NEGATIVE
  // count passes it and `sumSessionLocDedupedByBranch` clamps the row out of the
  // fold. The resulting `0` is byte-identical to the verified zero above.
  it("publishes no ratio when a cohort line count is negative", async () => {
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1", loc: -500, cost: 2, tokens: 4000 })],
      baselineSum: PRICED_BASELINE,
    });

    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });

    // Certifying this row would render -100% for a cohort whose lines are not a
    // measurement at all.
    expect(result.locDelta).toBeNull();
  });

  it("rejects a negative line count even when the fold is positive", async () => {
    // The boundary that tells the negative rule apart from the unmeasured one: a
    // positive fold EXCUSES a null-LOC row (normal, common) and must not excuse
    // a corrupt one. Without this case the negative arm could be folded into
    // `unmeasuredLocRows` and nothing would go red.
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s1", loc: 8000, cost: 2, tokens: 4000 }),
        row({ id: "s2", loc: -500, cost: 2, tokens: 4000 }),
      ],
      baselineSum: PRICED_BASELINE,
    });

    const result = await computeCohortPerformance(db, ORG, ["s1", "s2"], {
      cohortSampled: false,
    });

    expect(result.locDelta).toBeNull();
  });

  // whitlockk, #6878: a corrupt persisted value must not just vanish into a null
  // metric. AGENTS.md's bad-data contract wants it on a monitored event.
  it("raises the monitored event for a corrupt cohort cost", async () => {
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s1", loc: 4000, cost: 2, tokens: 4000 }),
        row({ id: "s2", loc: 4000, cost: -1.5, tokens: 4000 }),
      ],
      baselineSum: PRICED_BASELINE,
    });

    await computeCohortPerformance(db, ORG, ["s1", "s2"], {
      cohortSampled: false,
    });

    expect(log.error).toHaveBeenCalledWith(
      CORRUPT_COHORT_METRIC_EVENT,
      expect.objectContaining({
        minimumCostUsd: -1.5,
        negativeCostRows: 1,
        organizationId: ORG,
        rowCount: 2,
        scope: CohortMetricScope.Cohort,
      })
    );
  });

  it("raises the monitored event for a corrupt cohort line count", async () => {
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1", loc: -500, cost: 2, tokens: 4000 })],
      baselineSum: PRICED_BASELINE,
    });

    await computeCohortPerformance(db, ORG, ["s1"], { cohortSampled: false });

    expect(log.error).toHaveBeenCalledWith(
      CORRUPT_COHORT_METRIC_EVENT,
      expect.objectContaining({
        negativeLocRows: 1,
        scope: CohortMetricScope.Cohort,
      })
    );
  });

  it("raises the monitored event for a corrupt baseline cost", async () => {
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1", loc: 4000, cost: 2, tokens: 4000 })],
      baselineSum: PRICED_BASELINE,
      baselineCostCoverage: {
        rowCount: 4,
        pricedRows: 4,
        minimumEstimatedCost: -0.25,
      },
    });

    await computeCohortPerformance(db, ORG, ["s1"], { cohortSampled: false });

    expect(log.error).toHaveBeenCalledWith(
      CORRUPT_COHORT_METRIC_EVENT,
      expect.objectContaining({
        minimumCostUsd: -0.25,
        // The rowless aggregate detects the negative without being able to count
        // the rows carrying one; `0` would misreport that as "read, and clean".
        negativeCostRows: null,
        rowCount: 4,
        scope: CohortMetricScope.Baseline,
      })
    );
  });

  it("stays silent when nothing corrupt was read", async () => {
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1", loc: 4000, cost: 2, tokens: 4000 })],
      baselineSum: PRICED_BASELINE,
      baselineCostCoverage: { rowCount: 3, pricedRows: 3 },
    });

    await computeCohortPerformance(db, ORG, ["s1"], { cohortSampled: false });

    expect(log.error).not.toHaveBeenCalledWith(
      CORRUPT_COHORT_METRIC_EVENT,
      expect.anything()
    );
  });
});
