import { describe, expect, it } from "vitest";
import {
  toCostSplitFields,
  toPriorUsageFigures,
} from "@/app/agent-sessions/service/usage-sql-cost-fields";
import type {
  UsageSqlCostSplit,
  UsageSqlTotals,
} from "@/app/agent-sessions/service/usage-sql-reader";

const split = (over: Partial<UsageSqlCostSplit> = {}): UsageSqlCostSplit => ({
  subscriptionCost: 0,
  meteredCost: 0,
  unclassifiedCost: 0,
  ...over,
});

const totals = (over: Partial<UsageSqlTotals> = {}): UsageSqlTotals => ({
  sessionCount: 0,
  earliestSessionAt: null,
  latestSessionAt: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCost: 0,
  ...over,
});

describe("toCostSplitFields", () => {
  it("sums the total over all three ledgers", () => {
    const fields = toCostSplitFields(
      split({ subscriptionCost: 10, meteredCost: 4, unclassifiedCost: 1 })
    );
    expect(fields.totalEstimatedCost).toBe(15);
  });

  it("derives apiEstimatedCost as metered + unknown, the current meaning", () => {
    // NOT "API-billed" — see ISS-8559. This reproduces the existing contract on
    // purpose; a read path is the wrong place to change what a field means.
    const fields = toCostSplitFields(
      split({ subscriptionCost: 10, meteredCost: 4, unclassifiedCost: 1 })
    );
    expect(fields.apiEstimatedCost).toBe(5);
    expect(fields.meteredEstimatedCost).toBe(4);
    expect(fields.unknownEstimatedCost).toBe(1);
  });

  it("keeps the documented identities", () => {
    const fields = toCostSplitFields(
      split({
        subscriptionCost: 7.5,
        meteredCost: 2.25,
        unclassifiedCost: 0.25,
      })
    );
    expect(
      (fields.meteredEstimatedCost ?? 0) + (fields.unknownEstimatedCost ?? 0)
    ).toBeCloseTo(fields.apiEstimatedCost, 6);
    expect(
      fields.subscriptionEstimatedCost + fields.apiEstimatedCost
    ).toBeCloseTo(fields.totalEstimatedCost, 6);
  });

  it("treats a ledger that classified nothing as zero dollars", () => {
    // Not the D4 coercion: the ledgers partition an already-counted population,
    // so "nothing classified as subscription" is a fact, not an absence.
    const fields = toCostSplitFields(
      split({ subscriptionCost: null, meteredCost: null, unclassifiedCost: 3 })
    );
    expect(fields.subscriptionEstimatedCost).toBe(0);
    expect(fields.meteredEstimatedCost).toBe(0);
    expect(fields.totalEstimatedCost).toBe(3);
  });

  it("always emits both optional halves, because this producer can split", () => {
    // They are optional in the contract only for a Desktop predating ISS-4773,
    // where undefined means "cannot split" rather than "nothing was billed".
    const fields = toCostSplitFields(split());
    expect(fields.meteredEstimatedCost).toBe(0);
    expect(fields.unknownEstimatedCost).toBe(0);
    expect(fields.meteredEstimatedCost).not.toBeUndefined();
  });
});

describe("toPriorUsageFigures", () => {
  it("totals all four token counters, not the uncached pair", () => {
    // ISS-7175: reading only input+output would leave every cache token out of
    // the baseline alone, reporting a fabricated rise on a flat period.
    const figures = toPriorUsageFigures(
      totals({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5000,
        cacheWriteTokens: 300,
      }),
      split()
    );
    expect(figures.totalTokens).toBe(5420);
  });

  it("carries the session count and both cost bases", () => {
    const figures = toPriorUsageFigures(
      totals({ sessionCount: 64 }),
      split({ subscriptionCost: 10, meteredCost: 4, unclassifiedCost: 1 })
    );
    expect(figures).toEqual({
      totalSessions: 64,
      totalTokens: 0,
      meteredEstimatedCost: 4,
      apiEstimatedCost: 5,
      totalEstimatedCost: 15,
    });
  });

  it("does not carry a prior mergedPrCount", () => {
    // It reaches the fold from the delivery pass, which already holds it.
    const figures = toPriorUsageFigures(totals(), split());
    expect(figures).not.toHaveProperty("mergedPrCount");
  });
});
