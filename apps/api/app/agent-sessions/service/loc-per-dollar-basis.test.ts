/**
 * ISS-9906 — the drift guard behind one line of a PUBLISHED docstring.
 *
 * `LocPerDollarCoverageState`'s docstring in
 * `packages/api/src/types/loc-per-dollar-coverage.ts` now states which members
 * each producer can reach, because the previous blanket claim ("every
 * non-`Complete` member is a state a real read can reach") was false and a
 * client author deciding whether to handle a member reads that docstring.
 *
 * `CostBasisExcluded` is the member that is unreachable on BOTH producers, and
 * the reason is here rather than in either of them: `resolveLocPerDollarCostBasis`
 * is the only thing that ever produces `excludedUsd`, and it returns a hardcoded
 * 0. `resolveCoverageState` fires that member on `costBasisExcludedUsd > 0`, so
 * a constant 0 makes it dead.
 *
 * That is a fact about ONE function, which means it can be pinned — and a claim
 * in a published contract that nothing pins is exactly the prose that goes stale.
 * If a second basis is ever introduced that genuinely excludes spend, this fails
 * and whoever adds it has to go update the docstring rather than leave it lying.
 */
import { describe, expect, it } from "vitest";
import {
  LocPerDollarBasis,
  resolveLocPerDollarCostBasis,
} from "./loc-per-dollar-basis";
import type { SessionCostSplit } from "./usage-cost-split";

/**
 * Every ledger present and NO cast, so the compiler is doing its job.
 *
 * The cast that used to close this hid a missing `unknownEstimatedCost`. It did
 * not matter while `resolveLocPerDollarCostBasis` reads only
 * `totalEstimatedCost` — but catching drift in that function is the entire
 * point of the file, so a change that made it consult the unknown ledger would
 * have been handed `undefined` with the cast suppressing the error
 * (tamsinb and whitlockk on #6976).
 */
function costSplit(
  overrides: Partial<SessionCostSplit> = {}
): SessionCostSplit {
  return {
    totalEstimatedCost: 100,
    subscriptionEstimatedCost: 40,
    apiEstimatedCost: 60,
    meteredEstimatedCost: 55,
    unknownEstimatedCost: 5,
    ...overrides,
  };
}

describe("resolveLocPerDollarCostBasis (ISS-9906 docstring guard)", () => {
  it("excludes NOTHING, which is what makes CostBasisExcluded unreachable", () => {
    // Spread across every ledger, so a basis that narrowed to one of them would
    // have something to exclude and this would move off zero.
    for (const split of [
      costSplit(),
      costSplit({ subscriptionEstimatedCost: 100, apiEstimatedCost: 0 }),
      costSplit({ subscriptionEstimatedCost: 0, apiEstimatedCost: 100 }),
      costSplit({ totalEstimatedCost: 0, apiEstimatedCost: 0 }),
      // UNKNOWN-ONLY. A basis that narrowed to just the unrecognised ledger
      // would leave every other shape above at zero and this guard green
      // (whitlockk on #6976).
      costSplit({
        subscriptionEstimatedCost: 0,
        meteredEstimatedCost: 0,
        apiEstimatedCost: 100,
        unknownEstimatedCost: 100,
      }),
    ]) {
      expect(resolveLocPerDollarCostBasis(split).excludedUsd).toBe(0);
    }
  });

  it("divides by the TOTAL, so the basis narrows nothing (ISS-6526)", () => {
    const basis = resolveLocPerDollarCostBasis(
      costSplit({ totalEstimatedCost: 137.5 })
    );

    expect(basis.basis).toBe(LocPerDollarBasis.Total);
    expect(basis.costUsd).toBe(137.5);
  });
});
