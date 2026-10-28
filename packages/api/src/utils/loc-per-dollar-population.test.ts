import { describe, expect, it } from "vitest";
import { InvocationLocPerDollarUncoveredOperand } from "../types/agent-component-invocation-lines.ts";
import {
  emitLocPerDollarWithLegacy,
  locPerDollarCostMeasured,
  locPerDollarDenominatorCost,
  locPerDollarFromPopulation,
  resolveSessionMergedAuthoredPrLoc,
} from "./loc-per-dollar.ts";

const SOME_OPERAND = InvocationLocPerDollarUncoveredOperand.Cost;

// The legacy compatibility alias key is named by a retired metric that
// `no-kloc-per-dollar-metric` bans from source, so these cases pin the
// canonical fields, the uncovered-operand key, and the alias value by position.
describe("emitLocPerDollarWithLegacy (ISS-4667 / ISS-10730)", () => {
  it("emits the ratio and the alias and no reason for a resolved ratio, even when a reason is passed", () => {
    const emitted = emitLocPerDollarWithLegacy(2500, SOME_OPERAND);
    expect(emitted.locPerDollar).toBe(2500);
    expect(Object.keys(emitted)).toHaveLength(2);
    expect("locPerDollarUncoveredOperand" in emitted).toBe(false);
    expect(Object.values(emitted)).toEqual([2500, 2.5]);
  });

  it("attaches the uncovered operand beside a null ratio", () => {
    const emitted = emitLocPerDollarWithLegacy(null, SOME_OPERAND);
    expect(emitted.locPerDollar).toBeNull();
    expect(emitted.locPerDollarUncoveredOperand).toBe(SOME_OPERAND);
    expect(Object.values(emitted)).toEqual([null, null, SOME_OPERAND]);
  });

  it("omits the reason key when a null ratio has no known operand", () => {
    const emitted = emitLocPerDollarWithLegacy(null);
    expect(Object.values(emitted)).toEqual([null, null]);
    expect("locPerDollarUncoveredOperand" in emitted).toBe(false);
  });

  it("passes a measured zero through canonically but emits a null legacy alias", () => {
    const emitted = emitLocPerDollarWithLegacy(0);
    expect(emitted.locPerDollar).toBe(0);
    expect(Object.values(emitted)).toEqual([0, null]);
  });
});

describe("locPerDollarCostMeasured (ISS-11226)", () => {
  it.each([
    [0, true],
    [12.5, true],
    [-0.01, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [null, false],
    [undefined, false],
  ])("classifies %s as measured=%s", (value, expected) => {
    expect(locPerDollarCostMeasured(value)).toBe(expected);
  });
});

describe("locPerDollarDenominatorCost (ISS-9732)", () => {
  it("returns a zero, complete verdict for an empty population", () => {
    expect(locPerDollarDenominatorCost([])).toStrictEqual({
      cost: 0,
      measured: 0,
      total: 0,
      coverageComplete: true,
    });
  });

  it("sums every member when all costs are measured, counting a genuine $0 as measured", () => {
    expect(
      locPerDollarDenominatorCost([
        { costUsd: 1.5 },
        { costUsd: 0 },
        { costUsd: 2.25 },
      ])
    ).toStrictEqual({
      cost: 3.75,
      measured: 3,
      total: 3,
      coverageComplete: true,
    });
  });

  it("excludes unmeasured members from the sum and marks coverage incomplete", () => {
    expect(
      locPerDollarDenominatorCost([
        { costUsd: 4 },
        { costUsd: null },
        { costUsd: undefined },
        { costUsd: -1 },
        { costUsd: Number.NaN },
        { costUsd: 6 },
      ])
    ).toStrictEqual({
      cost: 10,
      measured: 2,
      total: 6,
      coverageComplete: false,
    });
  });

  it("consumes a one-shot iterable exactly once", () => {
    function* members() {
      yield { costUsd: 1 };
      yield { costUsd: 2 };
    }
    expect(locPerDollarDenominatorCost(members())).toStrictEqual({
      cost: 3,
      measured: 2,
      total: 2,
      coverageComplete: true,
    });
  });
});

describe("locPerDollarFromPopulation (ISS-9732 / ISS-9980)", () => {
  it("divides lines by cost when coverage is complete", () => {
    expect(
      locPerDollarFromPopulation({
        lines: 300,
        cost: 4,
        coverageComplete: true,
      })
    ).toBe(75);
  });

  it("returns a real 0 for a verified zero numerator", () => {
    expect(
      locPerDollarFromPopulation({ lines: 0, cost: 4, coverageComplete: true })
    ).toBe(0);
  });

  // Pins current behavior. Looks odd: both operands are present and the value
  // is still withheld, which the root AGENTS.md "Never refuse a derivation you
  // have the inputs for" rule argues against. A coverage PR does not change it.
  it("returns null when coverage is incomplete, even with valid operands", () => {
    expect(
      locPerDollarFromPopulation({
        lines: 300,
        cost: 4,
        coverageComplete: false,
      })
    ).toBeNull();
  });

  it.each([
    [-1, 4],
    [Number.NaN, 4],
    [Number.POSITIVE_INFINITY, 4],
    [300, 0],
    [300, -2],
    [300, Number.NaN],
    [300, Number.POSITIVE_INFINITY],
  ])("returns null for impossible operands lines=%s cost=%s", (lines, cost) => {
    expect(
      locPerDollarFromPopulation({ lines, cost, coverageComplete: true })
    ).toBeNull();
  });
});

describe("resolveSessionMergedAuthoredPrLoc non-finite line coercion", () => {
  it.each([
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
    [undefined, Number.NaN],
    [null, Number.NEGATIVE_INFINITY],
  ])(
    "folds merged=%s legacy=%s to 0 lines, never NaN or Infinity",
    (merged, legacy) => {
      expect(
        resolveSessionMergedAuthoredPrLoc({
          mergedAuthoredPrLinesChanged: merged,
          authoredPrLinesChanged: legacy,
        })
      ).toStrictEqual({ lines: 0, merged: false });
    }
  );
});
