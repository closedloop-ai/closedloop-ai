// Sibling-slice import (insights → branches): the branch-detail headline cards
// render this very same chip, so their reason sentence has to keep the same noun
// (ISS-4995 review). Pinning it here is what stops the two surfaces drifting.
import { BRANCH_NO_BASELINE_REASON } from "@repo/app/branches/lib/branch-headline-copy";
import { KpiDeltaBasis } from "@closedloop-ai/loops-api/insights";
import { describe, expect, it } from "vitest";
import {
  NO_COMPARISON_CHIP_LABEL,
  NO_COMPARISON_LABEL,
} from "../../components/kpi-delta-placeholder";
import {
  KPI_NO_COMPARISON_REASON,
  KPI_NOT_COMPUTED_REASON,
  kpiNoComparisonReason,
} from "../kpi-no-comparison-copy";

describe("kpiNoComparisonReason (ISS-4995)", () => {
  it("names our own gap when the producer computes no comparison", () => {
    expect(kpiNoComparisonReason(KpiDeltaBasis.NotComputed)).toBe(
      KPI_NOT_COMPUTED_REASON
    );
  });

  it("defers to the placeholder default for a metric we do compare", () => {
    // A null delta on a compared metric is a fact about the window, which the
    // default sentence already states. Undefined means "don't override".
    expect(kpiNoComparisonReason(KpiDeltaBasis.Computed)).toBeUndefined();
  });

  it("defers to the placeholder default when the producer sends no basis", () => {
    // Version skew (a peer built before ISS-4995) and an absent KPI both land
    // here. Neither tells us the cause, so neither may assert one.
    expect(kpiNoComparisonReason(undefined)).toBeUndefined();
  });

  it("returns no override for an inherited property name", () => {
    // wongk review: `deltaBasis` is a wire field parsed from JSON, so the
    // declared type constrains nothing here. A plain index on `"__proto__"`
    // resolved to `Object.prototype`, and the tile hands the result to
    // `TooltipContent` as a React child — which throws on an object instead of
    // falling back to the generic reason.
    for (const inherited of ["__proto__", "constructor", "toString"]) {
      expect(kpiNoComparisonReason(inherited as KpiDeltaBasis)).toBeUndefined();
    }
  });

  it("returns no override for a basis this build does not know", () => {
    // A newer producer may send a third basis. It must degrade to the
    // reason-agnostic default, never assert a cause this build cannot support.
    expect(
      kpiNoComparisonReason("declined_over_ceiling" as KpiDeltaBasis)
    ).toBeUndefined();
  });

  it("covers every basis, so a new one cannot ship without copy", () => {
    // The keys-covered guard. `Record<KpiDeltaBasis, …>` already fails typecheck
    // on a missing entry; this pins that the runtime map matches the const set,
    // which a type alone cannot prove.
    expect(Object.keys(KPI_NO_COMPARISON_REASON).sort()).toEqual(
      Object.values(KpiDeltaBasis).sort()
    );
  });
});

describe("KPI_NOT_COMPUTED_REASON copy", () => {
  it("does not reuse the range sentence it exists to replace", () => {
    expect(KPI_NOT_COMPUTED_REASON).not.toBe(NO_COMPARISON_LABEL);
  });

  it("makes a different claim than the range sentence, not just different words", () => {
    // Review thread: the first draft was two words off the range sentence
    // ("A prior-period comparison isn't available for this metric yet."), so a
    // reader hovering two tiles side by side could not tell they had been told
    // different things. What separates them is the claim: the range sentence
    // reports something unavailable, this one says we never work it out. Pin the
    // vocabulary that carries the OTHER claim out of this sentence.
    const copy = KPI_NOT_COMPUTED_REASON.toLowerCase();
    expect(copy).not.toContain("prior");
    expect(copy).not.toContain("available");
    expect(copy).toContain("we don't calculate");
  });

  it("uses the chip's noun, so one control does not name one thing two ways", () => {
    // ISS-4995 review thread: the chip reads "No comparison" and a screen reader
    // announces the two back to back, so a sentence that said "trend" put two
    // nouns on one concept. "comparison" is the single noun, and it is also what
    // the branch-detail card's sentence uses on the other surface that renders
    // this same chip (sibling slice `branches/lib/branch-headline-copy.ts`).
    const copy = KPI_NOT_COMPUTED_REASON.toLowerCase();
    expect(NO_COMPARISON_CHIP_LABEL.toLowerCase()).toContain("comparison");
    expect(copy).toContain("comparison");
    expect(copy).not.toContain("trend");
    expect(BRANCH_NO_BASELINE_REASON.toLowerCase()).toContain("comparison");
  });

  it("does not hedge the claim with our word for the response behind the tile", () => {
    // ISS-4995 review thread: "from this data" was added to keep the sentence
    // honest on desktop, where the same tile reads the cloud routes in Cloud mode
    // and the local store in Local mode. Only one mode's tooltip is ever on
    // screen, so the contradiction it guarded against is invisible to a reader,
    // while "this data" reads as vague rather than scoped. "for this metric"
    // carries the scope instead.
    const copy = KPI_NOT_COMPUTED_REASON.toLowerCase();
    expect(copy).not.toContain("this data");
    expect(copy).toContain("for this metric");
  });

  it("blames neither the range nor the reader's history", () => {
    // The ISS-4995 defect in one assertion: the old copy pointed at the range
    // and at how much activity the org had, when `merged` and `cost` carried
    // live deltas in the very same response.
    const copy = KPI_NOT_COMPUTED_REASON.toLowerCase();
    expect(copy).not.toContain("range");
    expect(copy).not.toContain("activity");
    expect(copy).not.toContain("enough");
    // It says the gap is ours and still open, the way the branch-detail card's
    // sentence does (FEA-4241).
    expect(copy).toContain("yet");
  });
});
