import type { BranchKpi } from "@repo/api/src/types/branch";
import {
  BRANCH_KPI_METRIC_BASIS,
  BranchBaselineScope,
  BranchKpiState,
  BranchMetricBasis,
} from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import { resolveBranchBaselineComparison } from "../branch-baseline-comparison";
import { BranchNoComparisonReason } from "../branch-no-comparison-reason";

/**
 * ISS-4686 — the branch-detail headline cards show ONE branch's figure, while
 * every 30-day baseline the producers can compute is a CORPUS aggregate. These
 * cases pin that a baseline only earns a verdict when its population AND its
 * measurement match the value it would sit beside.
 */

/**
 * A branch-scoped LOC/$ card rendering 120: the value covers one branch's churn
 * ÷ cost, and `valueNumber` is the figure actually on screen.
 */
const LOC_CARD = {
  hasValue: true,
  valueNumber: 120,
  valueScope: BranchBaselineScope.Branch,
  valueBasis: BranchMetricBasis.ChurnPerDollar,
  baselineBasis: BRANCH_KPI_METRIC_BASIS.locPerDollar,
} as const;

/** A KPI whose own value IS the 120 the card renders (120 vs 100 = +20%). */
function baselinedKpi(scope: BranchBaselineScope): BranchKpi {
  return {
    value: 120,
    state: BranchKpiState.Available,
    baseline30d: 100,
    deltaPct: 20,
    comparisonScope: scope,
  };
}

describe("resolveBranchBaselineComparison", () => {
  it("suppresses the verdict when a CORPUS baseline is supplied to a branch-scoped card", () => {
    // The defect ISS-4686 guards: `locPerDollar.deltaPct` is the org's change
    // across every LOC-enriched branch. Printed beside this branch's ratio it
    // would read as a verdict about the branch.
    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      kpi: baselinedKpi(BranchBaselineScope.Corpus),
    });

    expect(result).toEqual({
      comparable: false,
      reason: BranchNoComparisonReason.ScopeMismatch,
    });
  });

  it("renders the delta when a BRANCH-scoped baseline measures the same thing", () => {
    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      kpi: baselinedKpi(BranchBaselineScope.Branch),
    });

    expect(result).toEqual({ comparable: true, deltaPct: 20 });
  });

  it("suppresses the verdict when the baseline measures a DIFFERENT span than the value", () => {
    // The lead-time card's second mismatch: `leadTimeForChangeMs` is
    // first-commit → merge, the card value is first-session → merge. Same
    // branch, same window — still not the same measurement.
    const result = resolveBranchBaselineComparison({
      kpi: baselinedKpi(BranchBaselineScope.Branch),
      hasValue: true,
      valueNumber: 120,
      valueScope: BranchBaselineScope.Branch,
      valueBasis: BranchMetricBasis.FirstSessionToMerge,
      baselineBasis: BRANCH_KPI_METRIC_BASIS.leadTimeForChangeMs,
    });

    expect(result).toEqual({
      comparable: false,
      reason: BranchNoComparisonReason.BasisMismatch,
    });
  });

  it("degrades an UNSCOPED baseline from an older producer to no comparison", () => {
    // Version skew: a producer predating ISS-4686 emits `baseline30d` with no
    // `comparisonScope`. Types don't police the wire, so the unknown provenance
    // must degrade to "cannot compare" rather than default into a verdict.
    // Modelled as an actual wire payload — the unscoped shape is unreachable
    // through our own types, which is precisely why it must be tested here.
    const legacyKpi: BranchKpi = JSON.parse(
      JSON.stringify({
        value: 120,
        state: BranchKpiState.Available,
        baseline30d: 100,
        deltaPct: 20,
      })
    );

    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      kpi: legacyKpi,
    });

    expect(result).toEqual({
      comparable: false,
      reason: BranchNoComparisonReason.UnknownScope,
    });
  });

  it("reports NotComputed when no baseline is supplied (today's state on every surface)", () => {
    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      kpi: {
        value: 120,
        state: BranchKpiState.Available,
        baseline30d: null,
        deltaPct: null,
      },
    });

    expect(result).toEqual({
      comparable: false,
      reason: BranchNoComparisonReason.NotComputed,
    });
  });

  it("reports NotComputed when analytics is not wired at all (desktop detail)", () => {
    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      kpi: undefined,
    });

    expect(result).toEqual({
      comparable: false,
      reason: BranchNoComparisonReason.NotComputed,
    });
  });

  it("reports NotComputed for a GATED KPI even when a baseline number rides along", () => {
    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      kpi: {
        value: null,
        state: BranchKpiState.Gated,
        baseline30d: 100,
        deltaPct: 20,
        comparisonScope: BranchBaselineScope.Branch,
      },
    });

    expect(result).toEqual({
      comparable: false,
      reason: BranchNoComparisonReason.NotComputed,
    });
  });

  it("degrades an UNRECOGNISED scope to UnknownScope, not a false ScopeMismatch", () => {
    // A newer producer ships a scope this build has never heard of. Routing it
    // through the mismatch branch would print a concrete reason ("covers all
    // branches") describing a population we cannot actually name.
    const futureScopeKpi: BranchKpi = JSON.parse(
      JSON.stringify({
        value: 120,
        state: BranchKpiState.Available,
        baseline30d: 100,
        deltaPct: 20,
        comparisonScope: "repository",
      })
    );

    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      kpi: futureScopeKpi,
    });

    expect(result).toEqual({
      comparable: false,
      reason: BranchNoComparisonReason.UnknownScope,
    });
  });

  it("suppresses the verdict when the KPI's own value is NOT the number on the card", () => {
    // Matching population and measurement still don't make `deltaPct` a
    // statement about this card: it is computed from `kpi.value`, and the cards
    // derive their own figures rather than rendering `kpi.value`.
    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      valueNumber: 21,
      kpi: baselinedKpi(BranchBaselineScope.Branch),
    });

    expect(result).toEqual({
      comparable: false,
      reason: BranchNoComparisonReason.ValueMismatch,
    });
  });

  it("suppresses the verdict when the card renders a qualitative value, not a number", () => {
    // The lead-time card's "In progress": a value is on screen (so it is not the
    // no-data state) but there is no quantity for a delta to describe.
    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      valueNumber: null,
      kpi: baselinedKpi(BranchBaselineScope.Branch),
    });

    expect(result).toEqual({
      comparable: false,
      reason: BranchNoComparisonReason.ValueMismatch,
    });
  });

  it("tolerates float noise between the producer's value and the card's", () => {
    // The two are computed independently over the same inputs, so bit-exact
    // equality would reject a legitimate comparison.
    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      valueNumber: 120 + 1e-12,
      kpi: baselinedKpi(BranchBaselineScope.Branch),
    });

    expect(result.comparable).toBe(true);
    // Derived from the card's own number, so the noise rides through the
    // percentage rather than being rejected.
    expect(result.comparable && result.deltaPct).toBeCloseTo(20, 9);
  });

  it("reports ValueUnavailable before any scope check when the card has no value", () => {
    // A delta beside a "No data" value compares to nothing, whatever its scope.
    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      hasValue: false,
      kpi: baselinedKpi(BranchBaselineScope.Branch),
    });

    expect(result).toEqual({
      comparable: false,
      reason: BranchNoComparisonReason.ValueUnavailable,
    });
  });

  it("derives the percentage instead of trusting a wire deltaPct that contradicts it", () => {
    // wongk review on #4242: value 21 against baseline 20 is a +5% move, but the
    // payload claims -50. Every gate above passes, so a trusted wire delta would
    // render the exact opposite verdict beside a number it disagrees with.
    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      valueNumber: 21,
      kpi: {
        value: 21,
        state: BranchKpiState.Available,
        baseline30d: 20,
        deltaPct: -50,
        comparisonScope: BranchBaselineScope.Branch,
      },
    });

    expect(result).toEqual({ comparable: true, deltaPct: 5 });
  });

  it("reports NotComputed for a ZERO baseline rather than an Infinity verdict", () => {
    // `(value - 0) / 0` is ±Infinity; a delta chip would colour that as a win.
    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      kpi: {
        value: 120,
        state: BranchKpiState.Available,
        baseline30d: 0,
        deltaPct: Number.POSITIVE_INFINITY,
        comparisonScope: BranchBaselineScope.Branch,
      },
    });

    expect(result).toEqual({
      comparable: false,
      reason: BranchNoComparisonReason.NotComputed,
    });
  });

  it("reports NotComputed for a NON-FINITE baseline", () => {
    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      kpi: {
        value: 120,
        state: BranchKpiState.Available,
        baseline30d: Number.NaN,
        deltaPct: Number.NaN,
        comparisonScope: BranchBaselineScope.Branch,
      },
    });

    expect(result).toEqual({
      comparable: false,
      reason: BranchNoComparisonReason.NotComputed,
    });
  });

  it("reports NotComputed when the KPI carries a baseline but no value", () => {
    // `deltaPct` is null exactly when `value` is; there is nothing to derive a
    // percentage from, so this is a missing comparison, not a mismatched one.
    const result = resolveBranchBaselineComparison({
      ...LOC_CARD,
      kpi: {
        value: null,
        state: BranchKpiState.Available,
        baseline30d: 100,
        deltaPct: null,
        comparisonScope: BranchBaselineScope.Branch,
      },
    });

    expect(result).toEqual({
      comparable: false,
      reason: BranchNoComparisonReason.NotComputed,
    });
  });
});
