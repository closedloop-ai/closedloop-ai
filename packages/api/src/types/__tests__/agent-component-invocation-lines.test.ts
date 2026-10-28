/**
 * @file agent-component-invocation-lines.test.ts
 * @description ISS-10730 — the per-invocation line-attribution contract: what a
 * storable line count is, what the session reconciliation publishes, and when a
 * per-component LOC/$ ratio is withheld and under whose name.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_MAX_LINES,
  InvocationLocPerDollarUncoveredOperand,
  isValidInvocationLineCount,
  reconcileAttributedInvocationLines,
  resolveInvocationLocPerDollar,
} from "../agent-component-invocation-lines.ts";

describe("isValidInvocationLineCount", () => {
  it("admits a whole non-negative count, zero included", () => {
    expect(isValidInvocationLineCount(0)).toBe(true);
    expect(isValidInvocationLineCount(42)).toBe(true);
  });

  /**
   * The whole impossible set, not the two a comparison catches. Each of these
   * renders as a confident real measurement once persisted, which is worse than
   * a refusal — `1.5` lines is a parse that went wrong, and `Number("")` is a
   * measured `0` for a call nobody measured.
   */
  it.each([
    ["fractional", 1.5],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["past the safe-integer ceiling", AGENT_COMPONENT_INVOCATION_MAX_LINES + 2],
    ["a blank string a raw SQLite cell hands back", ""],
    ["a numeric string", "7"],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(isValidInvocationLineCount(value)).toBe(false);
  });
});

describe("reconcileAttributedInvocationLines", () => {
  /**
   * TWO calls with DIFFERENT deltas, so the assertion cannot pass on a global
   * total: only the joinable one is attributed, and the unjoinable one is
   * COUNTED and its lines stay inside the published residual rather than being
   * dropped or folded onto a component that did not produce them.
   */
  it("attributes joinable calls, counts unjoinable ones, and publishes the residual", () => {
    const result = reconcileAttributedInvocationLines(
      [
        { providerToolUseId: "toolu_a", linesAdded: 10, linesRemoved: 3 },
        { providerToolUseId: null, linesAdded: 4, linesRemoved: 1 },
      ],
      { linesAdded: 20, linesRemoved: 5 }
    );
    expect(result.attributedAdded).toBe(10);
    expect(result.attributedRemoved).toBe(3);
    expect(result.attributedCalls).toBe(1);
    expect(result.unjoinableCalls).toBe(1);
    // 20 - 10 covers the unjoinable call's 4 AND the 6 no call claimed at all.
    expect(result.residualAdded).toBe(10);
    expect(result.residualRemoved).toBe(2);
  });

  it("reports an unknown session total as unknown, never as a zero residual", () => {
    const result = reconcileAttributedInvocationLines(
      [{ providerToolUseId: "toolu_a", linesAdded: 10, linesRemoved: 3 }],
      null
    );
    expect(result.sessionLinesKnown).toBe(false);
    expect(result.residualAdded).toBeNull();
    expect(result.residualRemoved).toBeNull();
    expect(result.attributedAdded).toBe(10);
  });

  /**
   * A Codex or OpenCode session with the ISS-4649 fold gap yields no
   * contributions and no session total: unknown, and specifically NOT a
   * confident zero residual over a zero attribution.
   */
  it("degrades a session with no measurement at all to unknown", () => {
    const result = reconcileAttributedInvocationLines([], null);
    expect(result.sessionLinesKnown).toBe(false);
    expect(result.residualAdded).toBeNull();
    expect(result.attributedCalls).toBe(0);
    expect(result.unjoinableCalls).toBe(0);
  });

  it("does not attribute or count a call whose delta is impossible", () => {
    const result = reconcileAttributedInvocationLines(
      [{ providerToolUseId: "toolu_a", linesAdded: 1.5, linesRemoved: 3 }],
      { linesAdded: 8, linesRemoved: 3 }
    );
    expect(result.attributedCalls).toBe(0);
    expect(result.unjoinableCalls).toBe(0);
    // The lines are still in the session total, so they surface as residual
    // rather than silently vanishing.
    expect(result.residualAdded).toBe(8);
  });
});

describe("resolveInvocationLocPerDollar", () => {
  it("divides when both operands are covered", () => {
    expect(
      resolveInvocationLocPerDollar({ lines: 500, costUsd: 2 })
    ).toStrictEqual({ state: "resolved", locPerDollar: 250 });
  });

  it("names cost when the lines resolved and the spend did not", () => {
    expect(
      resolveInvocationLocPerDollar({ lines: 500, costUsd: null })
    ).toStrictEqual({
      state: "suppressed",
      uncoveredOperand: InvocationLocPerDollarUncoveredOperand.Cost,
    });
  });

  it("names lines when the spend resolved and the lines did not", () => {
    expect(
      resolveInvocationLocPerDollar({ lines: null, costUsd: 12.5 })
    ).toStrictEqual({
      state: "suppressed",
      uncoveredOperand: InvocationLocPerDollarUncoveredOperand.Lines,
    });
  });

  /**
   * A MEASURED $0 is a real figure, so the ratio is undefined rather than
   * suppressed. Reporting `uncoveredOperand: "cost"` here would tell a reader
   * the spend is unknown for a component whose spend is known — the
   * measured-zero collapse ISS-9980 already ruled against for this metric.
   */
  it("separates a measured zero denominator from an absent one", () => {
    expect(
      resolveInvocationLocPerDollar({ lines: 500, costUsd: 0 })
    ).toStrictEqual({ state: "undefinedRatio", reason: "zero_cost" });
    expect(
      resolveInvocationLocPerDollar({ lines: 500, costUsd: null })
    ).toStrictEqual({
      state: "suppressed",
      uncoveredOperand: InvocationLocPerDollarUncoveredOperand.Cost,
    });
  });

  it("rejects a line count past the int4 ceiling the column can hold", () => {
    expect(
      isValidInvocationLineCount(AGENT_COMPONENT_INVOCATION_MAX_LINES)
    ).toBe(true);
    // Between int4 max and Number.MAX_SAFE_INTEGER: a safe integer the cloud
    // `integer` column cannot hold, which would reach `createMany` as an
    // unclassifiable 500 and stall the generation forever.
    expect(isValidInvocationLineCount(2_147_483_648)).toBe(false);
  });
});
