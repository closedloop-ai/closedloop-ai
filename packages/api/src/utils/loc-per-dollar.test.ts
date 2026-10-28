import { describe, expect, it } from "vitest";
import {
  LOC_PER_DOLLAR_LABEL,
  legacyKlocPerDollarFromLoc,
  locPerDollarFromCoercedLines,
  locPerDollarFromLegacyKlocPerDollar,
  locPerDollarFromLines,
  locPerDollarNumeratorLines,
  resolveLocPerDollar,
  resolveSessionMergedAuthoredPrLoc,
} from "./loc-per-dollar.ts";

describe("locPerDollarFromLines (ISS-4667)", () => {
  it("divides lines by cost with NO divide-by-1000", () => {
    expect(locPerDollarFromLines(1000, 2)).toBeCloseTo(500, 10);
    expect(locPerDollarFromLines(5000, 2.5)).toBeCloseTo(2000, 10);
  });

  it("keeps the reported session non-zero (4,004 lines / $4,574.72)", () => {
    const value = locPerDollarFromLines(4004, 4574.72);
    expect(value).not.toBeNull();
    expect(value).toBeCloseTo(0.875, 3);
    expect(value).toBeGreaterThan(0);
  });

  it("returns null when there is no cost to divide by", () => {
    expect(locPerDollarFromLines(1000, 0)).toBeNull();
    expect(locPerDollarFromLines(1000, -1)).toBeNull();
  });

  // ISS-9964 / ISS-9980 (RULED 2026-09-11). This case previously asserted
  // `locPerDollarFromLines(0, 5) === null`. That expectation is retired, not
  // weakened: the ruling moved the `null` off the numerator and onto the
  // denominator, because a MEASURED zero is a fact about the population — "this
  // session merged nothing, and you spent $5" — and suppressing it hid a real
  // measurement behind the same placeholder that means "we could not measure".
  it("divides a MEASURED zero numerator into a real 0", () => {
    expect(locPerDollarFromLines(0, 5)).toBe(0);
  });

  it("returns null for a NOT KNOWABLE numerator rather than a fabricated 0", () => {
    // The other half of the same ruling, and the reason the zero rule is safe: a
    // caller that could not resolve the merged count at all passes `null`, and
    // that must NOT collapse onto the measured-zero answer above.
    expect(locPerDollarFromLines(null, 5)).toBeNull();
  });

  it("refuses an impossible negative line count", () => {
    // Impossible rather than merely unknown — never coerced to a measured 0.
    expect(locPerDollarFromLines(-10, 5)).toBeNull();
  });

  it("returns null for non-finite inputs instead of NaN/Infinity", () => {
    expect(locPerDollarFromLines(Number.NaN, 5)).toBeNull();
    expect(locPerDollarFromLines(1000, Number.NaN)).toBeNull();
    expect(locPerDollarFromLines(1000, Number.POSITIVE_INFINITY)).toBeNull();
    expect(locPerDollarFromLines(Number.POSITIVE_INFINITY, 5)).toBeNull();
  });

  it("is never inverted — more lines for the same cost scores higher", () => {
    const cheap = locPerDollarFromLines(2000, 10);
    const expensive = locPerDollarFromLines(1000, 10);
    expect(cheap).not.toBeNull();
    expect(expensive).not.toBeNull();
    expect(cheap as number).toBeGreaterThan(expensive as number);
  });
});

describe("locPerDollarFromLegacyKlocPerDollar (ISS-4667 version skew)", () => {
  it("scales a legacy thousand-lines-per-dollar value into LOC/$", () => {
    expect(locPerDollarFromLegacyKlocPerDollar(0.000_875)).toBeCloseTo(
      0.875,
      10
    );
    expect(locPerDollarFromLegacyKlocPerDollar(2)).toBeCloseTo(2000, 10);
  });

  it("keeps an old producer's unavailable as null, never a fabricated number, and rejects nonpositive legacy input", () => {
    // A nonpositive legacy value is not a real efficiency score — it must not be
    // scaled into a fabricated positive number (ISS-4667 malformed-input guard).
    for (const bad of [null, undefined, Number.NaN, 0, -0.5]) {
      expect(locPerDollarFromLegacyKlocPerDollar(bad)).toBeNull();
    }
  });
});

describe("resolveLocPerDollar (ISS-4667 version skew)", () => {
  it("prefers the canonical value when the producer sends it", () => {
    expect(resolveLocPerDollar(0.88, 999)).toBeCloseTo(0.88, 10);
  });

  it("preserves an explicit canonical null as the producer's unavailable", () => {
    expect(resolveLocPerDollar(null, 2)).toBeNull();
  });

  it("falls back to the legacy value when the canonical field is omitted", () => {
    expect(resolveLocPerDollar(undefined, 0.000_875)).toBeCloseTo(0.875, 10);
  });

  it("returns null when the payload carries neither value", () => {
    expect(resolveLocPerDollar(undefined, undefined)).toBeNull();
  });

  it("normalizes a malformed negative/non-finite canonical to null without falling through to legacy", () => {
    // A present-but-negative canonical is authoritative-present (not omitted),
    // so it must NOT revive a stale legacy value; it degrades to unavailable.
    expect(resolveLocPerDollar(-1, 999)).toBeNull();
    expect(resolveLocPerDollar(Number.NaN, 999)).toBeNull();
    expect(resolveLocPerDollar(Number.POSITIVE_INFINITY, 999)).toBeNull();
  });

  /**
   * ISS-9980 (RULED 2026-09-11). This case previously expected `null` for a
   * canonical `0`; the expectation changed because the RULING changed what a
   * zero LOC/$ MEANS, not because the assertion was inconvenient.
   *
   * The producer now divides a known-zero numerator into a real `0`
   * (`locPerDollarFromLines(0, cost) === 0`, pinned above). Rejecting it here
   * put that measurement back behind the not-available placeholder at every
   * consumer of the server-projected field — while the "Lines changed" row
   * beside it rendered `0 in merged PRs`, which is the two-rows-disagreeing
   * contradiction this ruling exists to end. A `0` must survive the resolver,
   * and it must NOT fall through to a stale legacy value.
   */
  it("passes a MEASURED canonical zero through instead of collapsing it to unavailable", () => {
    expect(resolveLocPerDollar(0, 999)).toBe(0);
  });
});

describe("locPerDollarFromCoercedLines (ISS-9980 no-tri-state callers)", () => {
  it("divides a positive numerator exactly as the shared helper does", () => {
    expect(locPerDollarFromCoercedLines(1000, 2)).toBeCloseTo(500, 10);
  });

  /**
   * The component fold builds its numerator as `(linesAdded ?? 0) + (linesRemoved
   * ?? 0)` over rows whose columns are NULL until a sync lands, so a zero there
   * cannot be distinguished from "never measured" and must not be published as a
   * measured `0.00`. This is the deliberate counterpart to the session ratio's
   * ruled zero — same principle, opposite answer, because the session path has a
   * tri-state and this one does not.
   */
  it("refuses a zero numerator it cannot tell apart from never-measured", () => {
    expect(locPerDollarFromCoercedLines(0, 5)).toBeNull();
  });

  it("refuses a negative or non-finite numerator", () => {
    expect(locPerDollarFromCoercedLines(-10, 5)).toBeNull();
    expect(locPerDollarFromCoercedLines(Number.NaN, 5)).toBeNull();
    expect(
      locPerDollarFromCoercedLines(Number.POSITIVE_INFINITY, 5)
    ).toBeNull();
  });

  it("refuses an absent or nonpositive denominator", () => {
    expect(locPerDollarFromCoercedLines(1000, 0)).toBeNull();
    expect(locPerDollarFromCoercedLines(1000, -1)).toBeNull();
  });
});

describe("resolveSessionMergedAuthoredPrLoc (ISS-9980 malformed wire input)", () => {
  it("reports a genuine zero from the merge-gated key as MEASURED", () => {
    expect(
      resolveSessionMergedAuthoredPrLoc({ mergedAuthoredPrLinesChanged: 0 })
    ).toEqual({ lines: 0, merged: true });
  });

  /**
   * `mergedAuthoredPrLinesChanged` is an OPTIONAL CROSS-REPO field, so the types
   * do not constrain what a version-skewed producer actually puts on it. A
   * non-finite value folds to `0` in `toLineCount`; a bare non-null test would
   * then publish it as a measured zero, rendering `0 in merged PRs` and a `0`
   * LOC/$ for a session whose merged total is unreadable. A negative value is
   * worse — it passes straight through and renders `-5 in merged PRs`.
   */
  it("treats an impossible merged count as NOT KNOWABLE, not as a measured zero", () => {
    expect(
      resolveSessionMergedAuthoredPrLoc({
        mergedAuthoredPrLinesChanged: Number.NaN,
      }).merged
    ).toBe(false);
    expect(
      resolveSessionMergedAuthoredPrLoc({
        mergedAuthoredPrLinesChanged: Number.POSITIVE_INFINITY,
      }).merged
    ).toBe(false);
    expect(
      resolveSessionMergedAuthoredPrLoc({ mergedAuthoredPrLinesChanged: -5 })
        .merged
    ).toBe(false);
  });

  it("does not let the legacy key answer the merged question", () => {
    expect(
      resolveSessionMergedAuthoredPrLoc({ authoredPrLinesChanged: 400 })
    ).toEqual({ lines: 400, merged: false });
  });
});

describe("legacyKlocPerDollarFromLoc (ISS-4667 emit-side version skew)", () => {
  it("scales a canonical LOC per dollar back down into the legacy thousand-line alias", () => {
    expect(legacyKlocPerDollarFromLoc(0.875)).toBeCloseTo(0.000_875, 10);
    expect(legacyKlocPerDollarFromLoc(2000)).toBeCloseTo(2, 10);
  });

  it("round-trips with locPerDollarFromLegacyKlocPerDollar", () => {
    const loc = 0.875;
    const legacy = legacyKlocPerDollarFromLoc(loc);
    expect(legacy).not.toBeNull();
    expect(locPerDollarFromLegacyKlocPerDollar(legacy)).toBeCloseTo(loc, 10);
  });

  it("keeps an unavailable canonical as null, never a fabricated legacy number", () => {
    for (const bad of [
      null,
      undefined,
      Number.NaN,
      0,
      -0.5,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(legacyKlocPerDollarFromLoc(bad)).toBeNull();
    }
  });
});

describe("LOC_PER_DOLLAR_LABEL", () => {
  it("is the canonical lines-per-dollar label", () => {
    expect(LOC_PER_DOLLAR_LABEL).toBe("LOC / $");
  });
});

// ISS-9964 / ISS-9980 (RULED 2026-09-11). ISS-6113's six cases here pinned the
// `max(localWorkingTreeDiff, branchDiff, authoredPrLines)` precedence — "prefers
// the branch diff when it is the largest", "falls back to the local working-tree
// diff", and the NaN-poisons-the-max guard that only a `Math.max` needs. Those
// rungs are RETIRED, not broken: a local working tree and an unmerged branch
// diff are work in progress, and a branch spans sessions this one did not
// author, so neither measures delivered output. Their expectations have no
// subject left; what replaces them is the merged-only contract and, above all,
// the measured-zero / not-knowable distinction the ruling turns on.
describe("locPerDollarNumeratorLines (ISS-9964 / ISS-9980)", () => {
  it("counts the merge-gated field even when the legacy one is larger", () => {
    // The retired rungs are not passable here at all — the parameter type
    // declares only the two authored-PR keys, so reinstating a working-tree or
    // branch-diff rung fails `tsc` before it can fail a case. What IS still
    // reachable is the legacy key, kept larger on purpose so a fall-through
    // would return 12,000 rather than the merged 8,000.
    expect(
      locPerDollarNumeratorLines({
        mergedAuthoredPrLinesChanged: 8000,
        authoredPrLinesChanged: 12_000,
      })
    ).toBe(8000);
  });

  it("returns a MEASURED 0 when the merge-gated field says nothing merged", () => {
    // `0` is an ANSWER, and the `??`-not-`||` contract is what keeps it one: the
    // 8,000 lines the pre-merge-gate key counted (which INCLUDED open PRs) must
    // not be substituted for it. Under `||` this returns 8000.
    expect(
      locPerDollarNumeratorLines({
        mergedAuthoredPrLinesChanged: 0,
        authoredPrLinesChanged: 8000,
      })
    ).toBe(0);
  });

  it("returns null when no producer supplied the merge-gated count", () => {
    // Desktop before its first cloud sync. Not zero — nobody looked.
    expect(locPerDollarNumeratorLines({})).toBeNull();
    expect(
      locPerDollarNumeratorLines({ mergedAuthoredPrLinesChanged: null })
    ).toBeNull();
  });

  it("returns null for a version-skewed producer sending only the legacy key", () => {
    // `authoredPrLinesChanged` predates the merge gate, so its figure describes a
    // WIDER population. Reporting it under a merged-only label would be a
    // measurement nobody took.
    expect(
      locPerDollarNumeratorLines({ authoredPrLinesChanged: 8000 })
    ).toBeNull();
  });

  /**
   * ISS-9980 (RULED 2026-09-11). This case previously expected `0` here — it was
   * written to stop a malformed value propagating as `NaN`, and folding it to
   * `0` was how that was achieved. The anti-`NaN` contract still stands; the
   * ANSWER changed, because the ruling made `0` mean something it did not mean
   * before.
   *
   * A `0` numerator is now a MEASURED fact that divides into a real `0` LOC/$
   * and renders `0 in merged PRs`. So coercing an impossible count to `0` no
   * longer merely avoids `NaN` — it publishes a measurement nobody took, for a
   * session whose merged total is in fact unreadable. `mergedAuthoredPrLinesChanged`
   * is an optional cross-repo field, so a version-skewed producer can genuinely
   * put `NaN`, `Infinity`, or a negative on it. NOT KNOWABLE is the honest
   * answer, and it avoids `NaN` just as completely.
   */
  it("treats a malformed merge-gated value as NOT KNOWABLE, never as a measured 0", () => {
    expect(
      locPerDollarNumeratorLines({
        mergedAuthoredPrLinesChanged: Number.NaN,
      })
    ).toBeNull();
    expect(
      locPerDollarNumeratorLines({
        mergedAuthoredPrLinesChanged: Number.POSITIVE_INFINITY,
      })
    ).toBeNull();
    // A negative count used to pass straight through and render `-5 in merged
    // PRs` beside a LOC/$ card showing an em-dash.
    expect(
      locPerDollarNumeratorLines({ mergedAuthoredPrLinesChanged: -5 })
    ).toBeNull();
  });
});

describe("resolveSessionMergedAuthoredPrLoc (ISS-6114)", () => {
  // The `merged` half is the whole point of the ticket — it is what lets a
  // caller say "in merged PRs" only when the merge-gated field answered — and
  // before this block its ONLY coverage anywhere was a DOM query in @repo/app.
  // Deleting `merged` and hardcoding `false` reddened a renderer test, not a
  // contract test. Pinned here, at the owner.
  it("reports the canonical key as merged, including an explicit 0", () => {
    // `0` is an ANSWER ("nothing merged"), not an absence — the case that
    // separates `??` from `||`.
    expect(
      resolveSessionMergedAuthoredPrLoc({
        mergedAuthoredPrLinesChanged: 0,
        authoredPrLinesChanged: 8000,
      })
    ).toEqual({ lines: 0, merged: true });
  });

  it("falls back to the deprecated key and reports NOT merged", () => {
    expect(
      resolveSessionMergedAuthoredPrLoc({ authoredPrLinesChanged: 25 })
    ).toEqual({ lines: 25, merged: false });
  });

  it("treats an explicit null canonical key as absent, not as merged", () => {
    expect(
      resolveSessionMergedAuthoredPrLoc({
        mergedAuthoredPrLinesChanged: null,
        authoredPrLinesChanged: 25,
      })
    ).toEqual({ lines: 25, merged: false });
  });

  it("answers 0 / not merged when neither key is present", () => {
    expect(resolveSessionMergedAuthoredPrLoc({})).toEqual({
      lines: 0,
      merged: false,
    });
  });
});
