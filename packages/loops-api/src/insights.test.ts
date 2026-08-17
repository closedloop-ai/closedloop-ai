import { describe, expect, it } from "vitest";
import {
  COST_KPI_SUB,
  comparableKpi,
  formatDeltaPct,
  isDeltaCapped,
  KpiDeltaBasis,
  KpiFormat,
  kpi,
  lifespanHistogram,
  MAX_DELTA_PCT,
  NEAR_ZERO_DELTA_BASE,
  pctDelta,
  SizeCoveragePopulation,
  ttmHistogram,
  withSizeCoverage,
} from "./insights";

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("ttmHistogram / lifespanHistogram (FEA-2971 shared buckets)", () => {
  it("buckets time-to-merge latencies by the TTM boundaries", () => {
    const result = ttmHistogram([HOUR, 6 * HOUR, 2 * DAY, 10 * DAY]);
    expect(result.find((b) => b.key === "lt4h")?.value).toBe(1);
    expect(result.find((b) => b.key === "4to12h")?.value).toBe(1);
    expect(result.find((b) => b.key === "1to3d")?.value).toBe(1);
    expect(result.find((b) => b.key === "gt3d")?.value).toBe(1);
  });

  it("buckets branch lifespans on the coarser day/week boundaries", () => {
    const result = lifespanHistogram([HOUR, 3 * DAY, 30 * DAY]);
    expect(result.find((b) => b.key === "short")?.value).toBe(1);
    expect(result.find((b) => b.key === "med")?.value).toBe(1);
    expect(result.find((b) => b.key === "long")?.value).toBe(1);
  });

  it("renders identical merge-latency data into stable per-surface labels", () => {
    // The parity bug this consolidation fixes: the same latency must land in the
    // same bucket regardless of which surface (cloud/desktop) computed it.
    expect(ttmHistogram([3 * HOUR]).map((b) => [b.key, b.value])).toEqual([
      ["lt4h", 1],
      ["4to12h", 0],
      ["12to24h", 0],
      ["1to3d", 0],
      ["gt3d", 0],
    ]);
  });
});

describe("pctDelta (FEA-2895 reconciled contract)", () => {
  it("returns null when prior is zero — no baseline to compute a percentage", () => {
    // Empty-prior case per the KpiStat.deltaPct contract; callers hide the chip
    // rather than surface a misleading +100% off a 0 baseline.
    expect(pctDelta(10, 0)).toBeNull();
    expect(pctDelta(0, 0)).toBeNull();
    expect(pctDelta(0.2, 0)).toBeNull();
  });

  it("computes signed percent change against a non-zero prior", () => {
    expect(pctDelta(12, 10)).toBe(20);
    expect(pctDelta(8, 10)).toBe(-20);
    expect(pctDelta(2, 1)).toBe(100);
  });

  it("rounds to a whole percent", () => {
    // 21.53 vs 7.00 → 207.57…% rounds to 208.
    expect(pctDelta(21.53, 7)).toBe(208);
    expect(pctDelta(10.4, 10)).toBe(4);
  });

  it("returns 0 when current equals a non-zero prior", () => {
    expect(pctDelta(10, 10)).toBe(0);
  });

  it("returns null for NaN inputs", () => {
    expect(pctDelta(Number.NaN, 10)).toBeNull();
    expect(pctDelta(10, Number.NaN)).toBeNull();
    expect(pctDelta(Number.NaN, Number.NaN)).toBeNull();
  });

  it("returns null for Infinity inputs", () => {
    expect(pctDelta(Number.POSITIVE_INFINITY, 10)).toBeNull();
    expect(pctDelta(Number.NEGATIVE_INFINITY, 10)).toBeNull();
    expect(pctDelta(10, Number.POSITIVE_INFINITY)).toBeNull();
    expect(pctDelta(10, Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it("returns -100 when current is zero and prior is non-zero", () => {
    expect(pctDelta(0, 5)).toBe(-100);
  });

  it("handles negative prior values", () => {
    expect(pctDelta(-20, -10)).toBe(100);
    expect(pctDelta(-5, -10)).toBe(-50);
  });
});

describe("pctDelta near-zero base + ceiling guard (FEA-3959)", () => {
  it("suppresses the delta when the prior base is near-zero (not a real baseline)", () => {
    // A prior magnitude below the floor is the +5400% division-artifact case on
    // a young product: a fractional prior spend/KLOC has no meaningful baseline,
    // so the delta is suppressed (null) → the UI shows "no prior data", never a
    // mega-percentage.
    expect(pctDelta(55, 0.3)).toBeNull();
    expect(pctDelta(10, 0.5)).toBeNull();
    expect(pctDelta(10, NEAR_ZERO_DELTA_BASE / 2)).toBeNull();
    expect(pctDelta(-10, -0.4)).toBeNull();
  });

  it("still forms a comparison at a whole-unit prior of 1", () => {
    // The floor sits just under 1 so a whole prior count of 1 is a real baseline.
    expect(pctDelta(2, 1)).toBe(100);
    expect(pctDelta(1, 1)).toBe(0);
  });

  it("declines to compare past the ceiling instead of asserting a capped ratio (ISS-5003)", () => {
    // The production case: one prior session against 4,257 current is a 425,600%
    // ratio. It used to surface as a confident "↑ >999%" growth chip beside
    // seven honest "No comparison" cards. A baseline of 1 cannot support a
    // percentage that large, so the derivation now returns null and the card
    // renders the no-comparison state it already ships.
    expect(pctDelta(4257, 1)).toBeNull();
    expect(pctDelta(55, 1)).toBeNull();
    // Symmetric on the negative side.
    expect(pctDelta(-2000, 100)).toBeNull();
  });

  it("declines a large-baseline multiple too — the ceiling is about the ratio, not the baseline", () => {
    // 100 → 1,379 is a solid baseline and still exceeds the ceiling. FEA-3959
    // already ruled such magnitudes unreadable; this stops rendering the
    // unreadable figure rather than re-litigating where the ceiling sits. The
    // richer treatment (an absolute from → to pair) needs a wire field this
    // contract does not have, and is deliberately not approximated here.
    expect(pctDelta(1379, 100)).toBeNull();
  });

  it("keeps every delta strictly inside the ceiling exact", () => {
    expect(pctDelta(120, 100)).toBe(20);
    expect(pctDelta(1098, 100)).toBe(998);
    expect(pctDelta(MAX_DELTA_PCT - 1 + 100, 100)).toBe(MAX_DELTA_PCT - 1);
  });

  it("declines AT the ceiling too, so no ±999 can be minted here (ISS-5003)", () => {
    // Review thread. The first cut used `>`, which let an exactly-999% change
    // survive — and `formatDeltaPct` cannot tell that precise figure apart from a
    // clamp, so it rendered ">999%": a bound asserted over a number we actually
    // had, on a change whose entire thesis is the opposite. `>=` gives up the
    // exact-999 case and buys back a ">999%" that is TRUE wherever it appears.
    // (1099 − 100) / 100 = exactly +999%.
    expect(pctDelta(1099, 100)).toBeNull();
    // (-899 − 100) / 100 = exactly -999%.
    expect(pctDelta(-899, 100)).toBeNull();
    // The chip string is the thing that was lying; prove it end to end.
    expect(formatDeltaPct(pctDelta(1099, 100))).toBeNull();
  });

  it("isDeltaCapped survives as the version-skew reader for ceiling values", () => {
    // pctDelta can no longer mint a ±999 at all, so EVERY ±999 reaching this
    // predicate came from a version-skewed producer (an older desktop build, a
    // cached payload) where it does mean a clamp — which is what makes the
    // ">999%" render a true statement. Retained deliberately: removing it would
    // strand those peers on an unlabelled figure that reads as a precise 999%.
    expect(isDeltaCapped(MAX_DELTA_PCT)).toBe(true);
    expect(isDeltaCapped(-MAX_DELTA_PCT)).toBe(true);
    expect(isDeltaCapped(pctDelta(120, 100))).toBe(false);
    expect(isDeltaCapped(pctDelta(1, 200))).toBe(false); // -100%, not capped
    expect(isDeltaCapped(null)).toBe(false);
  });
});

describe("formatDeltaPct (shared delta-chip display SSOT, FEA-3959/3960)", () => {
  it("returns null when there is no comparison", () => {
    expect(formatDeltaPct(null)).toBeNull();
  });

  it("renders a plain signed percent for sub-ceiling deltas", () => {
    expect(formatDeltaPct(12)).toBe("+12%");
    expect(formatDeltaPct(-7)).toBe("-7%");
    expect(formatDeltaPct(0)).toBe("0%");
  });

  it("renders a ceiling-value delta with the comparison glyph, not '+999%+'", () => {
    // Compatibility path (ISS-5003): a ±999 arriving from a version-skewed
    // producer that still clamps keeps its "at least this big" glyph.
    expect(formatDeltaPct(MAX_DELTA_PCT)).toBe(`>${MAX_DELTA_PCT}%`);
    expect(formatDeltaPct(-MAX_DELTA_PCT)).toBe(`<-${MAX_DELTA_PCT}%`);
    // Just under the ceiling stays a plain signed percent.
    expect(formatDeltaPct(MAX_DELTA_PCT - 1)).toBe(`+${MAX_DELTA_PCT - 1}%`);
  });

  it("never renders a '>999%' chip for a mega-multiple this build produced (ISS-5003)", () => {
    // End to end through the real derivation: the 4,257-vs-1 case that shipped
    // "↑ >999%" now produces no chip string at all, so the tile falls through to
    // its no-comparison placeholder instead of asserting a growth figure.
    expect(pctDelta(4257, 1)).toBeNull();
    expect(formatDeltaPct(pctDelta(4257, 1))).toBeNull();
    expect(formatDeltaPct(pctDelta(55, 1))).toBeNull();
  });
});

// Words that assert money actually left the account. The Dashboard cost KPI is
// subscription-INCLUSIVE, so most of what it counts is a counterfactual — what
// covered usage WOULD have cost if billed — and none of these are true of it.
const BILLED_MONEY_CLAIMS = ["spend", "spent", "billed", "charged", "paid"];

describe("Dashboard cost KPI caption (ISS-4994)", () => {
  it("does not claim the figure is money billed", () => {
    // The regression: the caption read "spend in range" over a total that on
    // real org data was ~75% subscription-covered.
    for (const claim of BILLED_MONEY_CLAIMS) {
      expect(COST_KPI_SUB.toLowerCase()).not.toContain(claim);
    }
  });

  it("names the basis, including that subscription-covered usage is in it", () => {
    // Not claiming "spend" is only half of it — a caption that says nothing
    // leaves the reader to assume the same wrong thing. The counterfactual
    // portion has to be visible on the card, which is what the Sessions surface
    // already does with its "if billed to API" line.
    expect(COST_KPI_SUB.toLowerCase()).toContain("cost");
    expect(COST_KPI_SUB.toLowerCase()).toContain("subscription");
  });

  it("stays scoped to the selected range", () => {
    // The caption sits under a range-filtered figure; dropping the window would
    // read as an all-time total.
    expect(COST_KPI_SUB.toLowerCase()).toContain("in range");
  });

  it("uses the one settled name for this number, not a third synonym", () => {
    // Review thread: an earlier cut said "modelled cost", making a third name
    // after the KPI info copy's "Estimated cost" and the chart titles' "Cost" —
    // and the only British spelling on the screen. Living in the SHARED module is
    // what makes this assertion cover BOTH producers: desktop's local-insights
    // renders this same constant, so it can no longer caption the identical
    // aggregate "estimated AI spend in window".
    expect(COST_KPI_SUB).toContain("estimated cost");
    expect(COST_KPI_SUB.toLowerCase()).not.toContain("modelled");
    expect(COST_KPI_SUB.toLowerCase()).not.toContain("incl.");
  });
});

describe("kpi / comparableKpi delta basis (ISS-4995)", () => {
  it("marks a plain kpi() as one this producer never compares", () => {
    // The honest default. `kloc` on cloud is built this way — no prior-window
    // figure is computed anywhere in that path, so no range and no amount of
    // history will ever produce a delta for it.
    expect(
      kpi("kloc", "KLOC merged", 863.5, KpiFormat.Number, "thousand lines")
        .deltaBasis
    ).toBe(KpiDeltaBasis.NotComputed);
  });

  it("marks comparableKpi() as compared even when the delta came back null", () => {
    // The case that makes the two constructors worth separating: a null delta
    // here means the WINDOW had no comparable prior period (the "all" range, or
    // a near-zero prior base), not that the comparison is unimplemented.
    const stat = comparableKpi(
      "merged",
      "Merged PRs",
      422,
      KpiFormat.Number,
      "PRs merged in range",
      null
    );
    expect(stat.deltaPct).toBeNull();
    expect(stat.deltaBasis).toBe(KpiDeltaBasis.Computed);
  });

  it("carries the basis alongside a real delta and the internal flag", () => {
    const stat = comparableKpi(
      "mergedCount",
      "Merged PRs",
      422,
      KpiFormat.Number,
      "PRs merged in range",
      -29,
      true
    );
    expect(stat).toMatchObject({
      deltaBasis: KpiDeltaBasis.Computed,
      deltaPct: -29,
      internal: true,
    });
  });

  it("cannot pair a not-computed basis with a delta figure", () => {
    // Review thread (insights.ts:161): `kpi()` took a `deltaPct` while
    // hard-stamping NotComputed, so one call site could emit a KPI carrying a
    // real computed delta while declaring the producer computes none. The
    // parameter is gone, so the only shape `kpi()` can emit is a null delta —
    // `internal` now sits at the 6th position, which this call also pins.
    const stat = kpi(
      "mergedKloc",
      "KLOC merged",
      863.5,
      KpiFormat.Number,
      "thousand lines landed",
      true
    );
    expect(stat).toMatchObject({
      deltaBasis: KpiDeltaBasis.NotComputed,
      deltaPct: null,
      internal: true,
    });
  });

  it("keeps `internal` off the wire for the common tile-backing KPI", () => {
    // Pre-existing contract (FEA-2946): the flag is omitted, not sent as false.
    // Adding deltaBasis must not smuggle it back in.
    expect("internal" in kpi("ttm", "TTM", 0, KpiFormat.Duration, "sub")).toBe(
      false
    );
  });
});

describe("withSizeCoverage (ISS-5414)", () => {
  it("quotes the sized share of the scanned population", () => {
    expect(
      withSizeCoverage(
        "thousand lines landed",
        19,
        7,
        SizeCoveragePopulation.Merged
      )
    ).toBe("thousand lines landed · sized 12 of 19 deduped merged PRs scanned");
  });

  it("still states the coverage when every scanned PR is sized", () => {
    // The affirmative matters: dropping the clause at full coverage would make a
    // complete figure indistinguishable from one whose producer never reported
    // coverage at all.
    expect(
      withSizeCoverage("lines changed", 19, 0, SizeCoveragePopulation.Merged)
    ).toBe("lines changed · sized 19 of 19 deduped merged PRs scanned");
  });

  it("names the population it was actually taken of", () => {
    // Desktop's KLOC / PR-size tiles are over CAPTURED PRs, so printing
    // "merged" there would name a population those tiles do not measure.
    expect(
      withSizeCoverage(
        "median lines changed per captured PR",
        4,
        1,
        SizeCoveragePopulation.Captured
      )
    ).toBe(
      "median lines changed per captured PR · sized 3 of 4 captured PRs scanned"
    );
  });

  it("leaves the caption untouched when nothing was scanned", () => {
    // No population means no share to report — "sized 0 of 0" is noise.
    expect(
      withSizeCoverage("lines changed", 0, 0, SizeCoveragePopulation.Merged)
    ).toBe("lines changed");
  });

  it("clamps a sized count a skewed producer would drive negative", () => {
    // More unsized than scanned cannot happen from one consistent producer, but
    // "sized -3 of 2" reaching a tile is worse than an honest floor.
    expect(
      withSizeCoverage("lines changed", 2, 5, SizeCoveragePopulation.Merged)
    ).toBe("lines changed · sized 0 of 2 deduped merged PRs scanned");
  });
});
