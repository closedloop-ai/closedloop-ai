import { branchAnalyticsCohortRequestSchema } from "@repo/api/src/types/branch-analytics-cohort";
import {
  formatTraceCostForDisplay,
  formatTraceCostPrecise,
} from "@repo/lib/sessions/trace-cost-format";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dateRangeToLookbackDays,
  formatCompact,
  formatCost,
  formatCostPrecise,
  formatCurrencyWhole,
  formatLoc,
  formatLocPerDollar,
  formatLocPerDollarColumn,
  formatNumber,
  formatTokenCount,
  getDurationScaleMinutes,
  getStableUtcDateWindowForRange,
  getStartDateForRange,
  KPI_NO_VALUE,
  PRECISE_COST_ABOVE_NEGATIVE_FLOOR,
  PRECISE_COST_BELOW_FLOOR,
  WHOLE_CURRENCY_ABOVE_NEGATIVE_FLOOR,
  WHOLE_CURRENCY_BELOW_FLOOR,
} from "../format-utils";

const START = "2026-06-10T12:00:00.000Z";

function plus(seconds: number): string {
  return new Date(Date.parse(START) + seconds * 1000).toISOString();
}

describe("formatTokenCount", () => {
  describe("sub-thousand values", () => {
    it("returns zero as-is", () => {
      expect(formatTokenCount(0)).toBe("0");
    });

    it("returns single-digit values as-is", () => {
      expect(formatTokenCount(1)).toBe("1");
      expect(formatTokenCount(9)).toBe("9");
    });

    it("returns values below 1000 as plain numbers", () => {
      expect(formatTokenCount(999)).toBe("999");
      expect(formatTokenCount(500)).toBe("500");
    });
  });

  describe("kilo tier (1k–999k)", () => {
    it("formats exactly 1000 as 1.00k", () => {
      expect(formatTokenCount(1000)).toBe("1.00k");
    });

    it("formats values in the kilo range with 2 decimal places", () => {
      expect(formatTokenCount(1500)).toBe("1.50k");
      expect(formatTokenCount(9999)).toBe("10.00k");
    });

    it("formats the upper boundary before tier transition", () => {
      expect(formatTokenCount(999_000)).toBe("999.00k");
    });

    it("tiers up at exactly 1_000_000 (becomes 1.00M not 1000.00k)", () => {
      expect(formatTokenCount(1_000_000)).toBe("1.00M");
    });
  });

  describe("mega tier (1M–999M)", () => {
    it("formats exactly 1_000_000 as 1.00M", () => {
      expect(formatTokenCount(1_000_000)).toBe("1.00M");
    });

    it("formats values in the mega range with 2 decimal places", () => {
      expect(formatTokenCount(1_500_000)).toBe("1.50M");
      expect(formatTokenCount(9_999_999)).toBe("10.00M");
    });

    it("formats the upper boundary before tier transition", () => {
      expect(formatTokenCount(999_000_000)).toBe("999.00M");
    });

    it("tiers up at exactly 1_000_000_000 (becomes 1.00B not 1000.00M)", () => {
      expect(formatTokenCount(1_000_000_000)).toBe("1.00B");
    });
  });

  describe("giga tier (1B+)", () => {
    it("formats exactly 1_000_000_000 as 1.00B", () => {
      expect(formatTokenCount(1_000_000_000)).toBe("1.00B");
    });

    it("formats very large values in the giga range with 2 decimal places", () => {
      expect(formatTokenCount(1_500_000_000)).toBe("1.50B");
      expect(formatTokenCount(10_000_000_000)).toBe("10.00B");
    });

    it("handles very large (multi-billion) values", () => {
      expect(formatTokenCount(500_000_000_000)).toBe("500.00B");
    });
  });

  describe("negative values", () => {
    it("returns negative sub-thousand values as plain numbers", () => {
      expect(formatTokenCount(-1)).toBe("-1");
      expect(formatTokenCount(-999)).toBe("-999");
    });

    it("returns negative values in kilo range without abbreviation (falls to toString)", () => {
      // -1000 is < 0, does not match any >= threshold, returns toString()
      expect(formatTokenCount(-1000)).toBe("-1000");
    });
  });

  describe("tier transition boundary values", () => {
    it("999 stays sub-thousand", () => {
      expect(formatTokenCount(999)).toBe("999");
    });

    it("1000 enters kilo tier", () => {
      expect(formatTokenCount(1000)).toBe("1.00k");
    });

    it("9999 is still in kilo tier", () => {
      expect(formatTokenCount(9999)).toBe("10.00k");
    });

    it("10000 is still in kilo tier", () => {
      expect(formatTokenCount(10_000)).toBe("10.00k");
    });

    it("999_994 stays in kilo tier (below rounding threshold)", () => {
      expect(formatTokenCount(999_994)).toBe("999.99k");
    });

    it("999_995 rounds up to 1.00M (boundary promotion)", () => {
      expect(formatTokenCount(999_995)).toBe("1.00M");
    });

    it("999_999 rounds up to 1.00M (tier promotion from 2dp rounding)", () => {
      expect(formatTokenCount(999_999)).toBe("1.00M");
    });

    it("999_999_999 rounds up to 1.00B (mega-to-giga promotion)", () => {
      expect(formatTokenCount(999_999_999)).toBe("1.00B");
    });
  });
});

describe("formatNumber", () => {
  describe("integer mode (isFractional = false, default)", () => {
    it("formats zero", () => {
      expect(formatNumber(0)).toBe("0");
    });

    it("formats positive whole numbers with comma separators", () => {
      expect(formatNumber(1000)).toBe("1,000");
      expect(formatNumber(13_523)).toBe("13,523");
      expect(formatNumber(1_000_000)).toBe("1,000,000");
    });

    it("rounds fractional inputs to nearest whole number", () => {
      expect(formatNumber(1.4)).toBe("1");
      expect(formatNumber(1.5)).toBe("2");
      expect(formatNumber(9.9)).toBe("10");
    });

    it("formats negative values", () => {
      expect(formatNumber(-1000)).toBe("-1,000");
      expect(formatNumber(-9999)).toBe("-9,999");
    });

    it("formats very large values", () => {
      expect(formatNumber(1_000_000_000)).toBe("1,000,000,000");
    });
  });

  describe("fractional mode (isFractional = true)", () => {
    describe("values with absolute value less than 10", () => {
      it("formats zero with 2 decimal places", () => {
        expect(formatNumber(0, true)).toBe("0.00");
      });

      it("formats values less than 1 with 2 decimal places", () => {
        expect(formatNumber(0.5, true)).toBe("0.50");
        expect(formatNumber(0.1, true)).toBe("0.10");
        expect(formatNumber(0.99, true)).toBe("0.99");
      });

      it("formats values just below 10 with 2 decimal places", () => {
        expect(formatNumber(9.5, true)).toBe("9.50");
        expect(formatNumber(9.99, true)).toBe("9.99");
      });

      it("formats negative values less than 10 in absolute value with 2 decimal places", () => {
        expect(formatNumber(-1, true)).toBe("-1.00");
        expect(formatNumber(-9.5, true)).toBe("-9.50");
      });
    });

    describe("values with absolute value 10 or greater", () => {
      it("formats value 10 as rounded whole number", () => {
        expect(formatNumber(10, true)).toBe("10");
      });

      it("formats larger values as rounded whole numbers with comma separators", () => {
        expect(formatNumber(1234, true)).toBe("1,234");
        expect(formatNumber(10_000, true)).toBe("10,000");
        expect(formatNumber(1_000_000, true)).toBe("1,000,000");
      });

      it("rounds fractional values at or above 10 to nearest whole number", () => {
        expect(formatNumber(10.4, true)).toBe("10");
        expect(formatNumber(10.5, true)).toBe("11");
        expect(formatNumber(99.9, true)).toBe("100");
      });

      it("formats negative values at or above 10 in absolute value as rounded whole numbers", () => {
        expect(formatNumber(-10, true)).toBe("-10");
        expect(formatNumber(-1000, true)).toBe("-1,000");
      });
    });

    describe("boundary at 10", () => {
      it("9.99 uses 2 decimal places (below threshold)", () => {
        expect(formatNumber(9.99, true)).toBe("9.99");
      });

      it("10.00 uses whole number (at threshold)", () => {
        expect(formatNumber(10.0, true)).toBe("10");
      });
    });

    describe("very large fractional values", () => {
      it("formats billion-scale fractional values as rounded integers", () => {
        expect(formatNumber(1_500_000_000.75, true)).toBe("1,500,000,001");
      });
    });
  });
});

describe("formatCost", () => {
  describe("defined values", () => {
    it("formats zero cost", () => {
      expect(formatCost(0)).toBe("$0.00");
    });

    it("formats a simple cost with 2 decimal places", () => {
      expect(formatCost(1.5)).toBe("$1.50");
      expect(formatCost(9.99)).toBe("$9.99");
    });

    it("formats large costs with comma separators", () => {
      expect(formatCost(1000)).toBe("$1,000.00");
      expect(formatCost(1_000_000)).toBe("$1,000,000.00");
    });

    it("formats fractional cent values rounded to 2 decimal places", () => {
      expect(formatCost(0.001)).toBe("$0.00");
      expect(formatCost(0.005)).toBe("$0.01");
      expect(formatCost(0.994)).toBe("$0.99");
      expect(formatCost(0.995)).toBe("$1.00");
    });

    it("formats values less than 1", () => {
      expect(formatCost(0.5)).toBe("$0.50");
      expect(formatCost(0.1)).toBe("$0.10");
    });

    it("formats negative costs", () => {
      // toLocaleString("en-US") places the currency sign before the minus
      expect(formatCost(-1)).toBe("$-1.00");
      expect(formatCost(-1000)).toBe("$-1,000.00");
    });

    it("formats very large costs", () => {
      expect(formatCost(1_000_000_000)).toBe("$1,000,000,000.00");
    });
  });

  describe("undefined value", () => {
    it("treats undefined as 0 and returns $0.00", () => {
      expect(formatCost(undefined)).toBe("$0.00");
    });
  });
});

describe("formatCostPrecise", () => {
  it("matches formatCost for a cent or more (no extra precision)", () => {
    expect(formatCostPrecise(0)).toBe("$0.00");
    expect(formatCostPrecise(0.01)).toBe("$0.01");
    expect(formatCostPrecise(1.5)).toBe("$1.50");
    expect(formatCostPrecise(1234.56)).toBe("$1,234.56");
  });

  it("treats exact zero and undefined as $0.00 (no false precision)", () => {
    expect(formatCostPrecise(0)).toBe("$0.00");
    expect(formatCostPrecise(undefined)).toBe("$0.00");
  });

  it("exposes a NONZERO figure for a sub-cent value instead of lying as $0.00", () => {
    // The whole point (Thread A): a bar is drawn, so the number must not read
    // "$0.00" while the segment is visibly there.
    expect(formatCostPrecise(0.003)).toBe("$0.003");
    expect(formatCostPrecise(0.0037)).toBe("$0.0037");
    expect(formatCostPrecise(0.009)).toBe("$0.009");
  });

  it("caps at 4 decimals for a truly negligible slice (rounds, still faithful)", () => {
    // Below 0.1¢ we cap precision at 4dp; the value rounds but does not fabricate
    // a long tail. (0.00005 rounds to $0.0001 — still nonzero, matching the bar.)
    expect(formatCostPrecise(0.000_05)).toBe("$0.0001");
  });

  it("keeps the sign for a sub-cent negative", () => {
    expect(formatCostPrecise(-0.003)).toBe("$-0.003");
  });
});

describe("formatCurrencyWhole", () => {
  it("rounds a large aggregate spend to whole dollars, keeping the separator", () => {
    // The "AI SPEND" KPI: $9,060.84 must render as $9,061 (rounds up, no cents).
    expect(formatCurrencyWhole(9060.84)).toBe("$9,061");
  });

  it("rounds up on a >= .5 fractional part", () => {
    expect(formatCurrencyWhole(1234.84)).toBe("$1,235");
    // .50 boundary rounds up (Math.round half-up).
    expect(formatCurrencyWhole(1234.5)).toBe("$1,235");
    expect(formatCurrencyWhole(0.5)).toBe("$1");
  });

  it("rounds down on a < .5 fractional part", () => {
    expect(formatCurrencyWhole(1234.49)).toBe("$1,234");
    expect(formatCurrencyWhole(9060.4)).toBe("$9,060");
  });

  it("never shows cents", () => {
    expect(formatCurrencyWhole(42)).toBe("$42");
    expect(formatCurrencyWhole(1_000_000)).toBe("$1,000,000");
  });

  it("treats undefined as 0", () => {
    expect(formatCurrencyWhole(undefined)).toBe("$0");
  });

  it("formats zero", () => {
    expect(formatCurrencyWhole(0)).toBe("$0");
  });

  describe("sub-dollar guard (nonzero totals that would round to $0)", () => {
    it("shows full cents instead of $0 for a nonzero total below the round boundary", () => {
      // A brand-new / low-usage org with $0.12 of spend must not read as $0.
      expect(formatCurrencyWhole(0.12)).toBe("$0.12");
      expect(formatCurrencyWhole(0.01)).toBe("$0.01");
      expect(formatCurrencyWhole(0.49)).toBe("$0.49");
    });

    it("still rounds to whole dollars at and above the $0.50 boundary", () => {
      expect(formatCurrencyWhole(0.5)).toBe("$1");
      expect(formatCurrencyWhole(0.99)).toBe("$1");
    });

    it("keeps exact zero as $0 (no cents, no marker)", () => {
      expect(formatCurrencyWhole(0)).toBe("$0");
      expect(formatCurrencyWhole(undefined)).toBe("$0");
    });

    // ISS-4919 / review of #4244: a REAL sub-cent total must not render "$0.00".
    // That is the same fabricated zero the Branches AI-spend null-on-zero rule
    // exists to stop, one decimal place lower — and it sits directly under a
    // caption reading "estimated cost in range", so it claims a measured zero
    // for money that was actually spent.
    it("shows a real sub-cent total as a nonzero figure, never $0.00", () => {
      expect(formatCurrencyWhole(0.004)).toBe("$0.004");
      expect(formatCurrencyWhole(0.004)).not.toBe("$0.00");
      expect(formatCurrencyWhole(0.0012)).toBe("$0.0012");
    });

    it("is unchanged between one cent and the round boundary", () => {
      // The precise fallback only widens the SUB-CENT band; everything from
      // $0.01 up renders exactly as the fixed-2dp formatter always did.
      // `formatCostPrecise`'s cutoff is $0.01 (not $0.005), so a half-cent
      // total is inside the widened band and shows its real figure rather
      // than the fixed-2dp round-up to "$0.01".
      expect(formatCurrencyWhole(0.01)).toBe("$0.01");
      expect(formatCurrencyWhole(0.005)).toBe("$0.005");
      expect(formatCurrencyWhole(0.49)).toBe("$0.49");
    });

    // ISS-4919 (the band #4244 left behind): widening to 4dp removed the $0.00
    // lie for the sub-cent band but not for the band UNDER it, where a real cost
    // still rounded back to a flat "$0.00" — indistinguishable from free.
    it("states a bound rather than a fabricated zero below the precision floor", () => {
      expect(formatCurrencyWhole(0.000_01)).toBe(WHOLE_CURRENCY_BELOW_FLOOR);
      expect(formatCurrencyWhole(0.000_01)).not.toBe("$0.00");
      expect(formatCurrencyWhole(0.000_000_1)).toBe(WHOLE_CURRENCY_BELOW_FLOOR);
    });

    // Review thread: the bound is stated at the precision THIS surface renders,
    // not at the deepest formatter's floor. A "< $0.0001" under a `$9,061`-shaped
    // headline is four decimals and a math operator on a whole-dollar tile — a
    // precision the surface uses nowhere else, which reads as a typo before it
    // reads as a bound. `< $0.0001` stays right where 4dp genuinely renders (the
    // branch timeline tooltip, the session trace).
    it("bounds at the tile's own precision, not the 4dp formatter's floor", () => {
      expect(formatCurrencyWhole(0.000_01)).toBe("< $0.01");
      expect(formatCurrencyWhole(0.000_01)).not.toBe(PRECISE_COST_BELOW_FLOOR);
      // Same rule the LOC/$ column adopted for the identical fact (ISS-4866):
      // bound at the column's precision.
      expect(WHOLE_CURRENCY_BELOW_FLOOR).toBe("< $0.01");
    });

    it("mirrors the bound for a sub-floor credit rather than borrowing the positive form", () => {
      expect(formatCurrencyWhole(-0.000_01)).toBe(
        WHOLE_CURRENCY_ABOVE_NEGATIVE_FLOOR
      );
      expect(WHOLE_CURRENCY_ABOVE_NEGATIVE_FLOOR).toBe("> -$0.01");
    });

    it("keeps a true zero visually distinct from a rounded-down nonzero", () => {
      // The whole point of the bound: these two facts must never render the
      // same string, or the reader cannot tell "free" from "too small to show".
      expect(formatCurrencyWhole(0)).toBe("$0");
      expect(formatCurrencyWhole(0)).not.toBe(WHOLE_CURRENCY_BELOW_FLOOR);
      expect(formatCurrencyWhole(0.000_01)).not.toBe(
        formatCurrencyWhole(0) as string
      );
    });
  });
});

describe("formatCostPrecise sub-floor bound (ISS-4919)", () => {
  it("renders every representable sub-cent figure exactly as before", () => {
    // The bound must not swallow the band FEA-3722 widened precision to expose.
    expect(formatCostPrecise(0.0037)).toBe("$0.0037");
    expect(formatCostPrecise(0.0001)).toBe("$0.0001");
  });

  it("switches to the bound only once 4dp rounding lands on zero", () => {
    // The boundary is the ROUNDING boundary, not the smallest unit: $0.00005
    // rounds up to a real $0.0001 and must keep that figure, so the bound starts
    // strictly below it. A bound one notch too high would suppress values the
    // formatter can still state honestly.
    expect(formatCostPrecise(0.000_05)).toBe("$0.0001");
    expect(formatCostPrecise(0.000_049)).toBe(PRECISE_COST_BELOW_FLOOR);
    expect(formatCostPrecise(0.000_000_5)).toBe(PRECISE_COST_BELOW_FLOOR);
  });

  it("mirrors the bound's direction for a negative magnitude", () => {
    // A credit below the floor is "greater than -$0.0001", not "less than
    // $0.0001" — borrowing the positive form would invert the claim.
    expect(formatCostPrecise(-0.000_01)).toBe(
      PRECISE_COST_ABOVE_NEGATIVE_FLOOR
    );
  });

  it("follows the LOC/$ column's existing less-than convention, not a new one", () => {
    // ISS-4866 already answered "a real value below what this formatter can
    // show" with a `< x` bound. Same fact, same shape — a second convention for
    // it would be drift.
    expect(PRECISE_COST_BELOW_FLOOR.startsWith("< ")).toBe(true);
    expect(formatLocPerDollarColumn(0.001).startsWith("< ")).toBe(true);
  });

  it("leaves an exact and an undefined zero alone", () => {
    expect(formatCostPrecise(0)).toBe("$0.00");
    expect(formatCostPrecise(undefined)).toBe("$0.00");
  });
});

describe("formatCompact", () => {
  describe("sub-thousand values", () => {
    it("returns zero as '0'", () => {
      expect(formatCompact(0)).toBe("0");
    });

    it("returns small values as rounded integers", () => {
      expect(formatCompact(42)).toBe("42");
      expect(formatCompact(999)).toBe("999");
    });

    it("rounds fractional sub-thousand values", () => {
      expect(formatCompact(42.7)).toBe("43");
    });
  });

  describe("kilo tier (1k–999k)", () => {
    it("formats exactly 1000 as '1k' (trailing .0 stripped)", () => {
      expect(formatCompact(1000)).toBe("1k");
    });

    it("formats values with fractional part", () => {
      expect(formatCompact(1800)).toBe("1.8k");
      expect(formatCompact(1500)).toBe("1.5k");
    });

    it("strips trailing .0 for round values", () => {
      expect(formatCompact(2000)).toBe("2k");
      expect(formatCompact(10_000)).toBe("10k");
    });

    it("formats upper boundary", () => {
      expect(formatCompact(999_000)).toBe("999k");
    });
  });

  describe("mega tier (1M–999M)", () => {
    it("formats exactly 1_000_000 as '1M'", () => {
      expect(formatCompact(1_000_000)).toBe("1M");
    });

    it("formats values with fractional part", () => {
      expect(formatCompact(1_500_000)).toBe("1.5M");
    });

    it("strips trailing .0 for round values", () => {
      expect(formatCompact(2_000_000)).toBe("2M");
    });
  });

  describe("giga tier (1B+)", () => {
    it("formats exactly 1_000_000_000 as '1B'", () => {
      expect(formatCompact(1_000_000_000)).toBe("1B");
    });

    it("formats values with fractional part", () => {
      expect(formatCompact(24_100_000_000)).toBe("24.1B");
    });
  });

  describe("negative values", () => {
    it("formats negative kilo values", () => {
      expect(formatCompact(-1800)).toBe("-1.8k");
    });

    it("formats negative mega values", () => {
      expect(formatCompact(-2_000_000)).toBe("-2M");
    });

    it("formats negative sub-thousand values", () => {
      expect(formatCompact(-500)).toBe("-500");
    });
  });

  describe("tier-carry boundary (1dp rounding to 1000.0 carries up)", () => {
    it("carries kilo → mega instead of rendering '1000k'", () => {
      expect(formatCompact(999_950)).toBe("1M");
    });

    it("carries mega → giga instead of rendering '1000M'", () => {
      expect(formatCompact(999_950_000)).toBe("1B");
    });

    it("stays in kilo tier just below the carry threshold", () => {
      expect(formatCompact(999_940)).toBe("999.9k");
    });

    it("stays in mega tier just below the carry threshold", () => {
      expect(formatCompact(999_940_000)).toBe("999.9M");
    });

    it("carries a negative value up a tier", () => {
      expect(formatCompact(-999_950)).toBe("-1M");
    });
  });
});

describe("formatLoc", () => {
  describe("below threshold (< 1000)", () => {
    it("formats zero", () => {
      expect(formatLoc(0)).toBe("0");
    });

    it("formats small values as comma-separated integers", () => {
      expect(formatLoc(500)).toBe("500");
      expect(formatLoc(892)).toBe("892");
      expect(formatLoc(999)).toBe("999");
    });

    it("rounds fractional values below threshold", () => {
      expect(formatLoc(42.7)).toBe("43");
    });
  });

  describe("at or above threshold (>= 1000)", () => {
    it("formats exactly 1000 as '1 KLOC' (trailing .0 stripped)", () => {
      expect(formatLoc(1000)).toBe("1 KLOC");
    });

    it("formats values with fractional KLOC", () => {
      expect(formatLoc(1500)).toBe("1.5 KLOC");
      expect(formatLoc(12_500)).toBe("12.5 KLOC");
    });

    it("strips trailing .0 for round KLOC values", () => {
      expect(formatLoc(2000)).toBe("2 KLOC");
      expect(formatLoc(12_000)).toBe("12 KLOC");
    });

    it("formats very large values", () => {
      expect(formatLoc(100_000)).toBe("100 KLOC");
      expect(formatLoc(1_000_000)).toBe("1000 KLOC");
    });
  });

  describe("negative values", () => {
    it("formats negative values below threshold as integers", () => {
      expect(formatLoc(-500)).toBe("-500");
    });

    it("formats negative values at or above threshold as KLOC", () => {
      expect(formatLoc(-1500)).toBe("-1.5 KLOC");
    });
  });
});

describe("getDurationScaleMinutes", () => {
  describe("rounding up to the nearest minute", () => {
    it("rounds 5m 5s up to 6 (FEA-2029 example)", () => {
      expect(getDurationScaleMinutes(START, plus(5 * 60 + 5))).toBe(6);
    });

    it("rounds 75m 1s up to 76 (FEA-2029 example)", () => {
      expect(getDurationScaleMinutes(START, plus(75 * 60 + 1))).toBe(76);
    });

    it("rounds up when a single second spills past the minute", () => {
      expect(getDurationScaleMinutes(START, plus(61))).toBe(2);
    });
  });

  describe("exact whole-minute durations stay put", () => {
    it("keeps an exact 5m 0s at 5 (no extra minute)", () => {
      expect(getDurationScaleMinutes(START, plus(5 * 60))).toBe(5);
    });

    it("keeps an exact 1m at 1", () => {
      expect(getDurationScaleMinutes(START, plus(60))).toBe(1);
    });
  });

  describe("sub-minute and zero-length sessions", () => {
    it("gives a sub-minute session a 1-minute scale", () => {
      expect(getDurationScaleMinutes(START, plus(5))).toBe(1);
    });

    it("gives a zero-length session a 1-minute scale", () => {
      expect(getDurationScaleMinutes(START, START)).toBe(1);
    });

    it("clamps clock skew (end before start) to a 1-minute scale", () => {
      expect(getDurationScaleMinutes(START, plus(-120))).toBe(1);
    });
  });

  describe("Date instances", () => {
    it("accepts Date objects as well as ISO strings", () => {
      expect(
        getDurationScaleMinutes(
          new Date(START),
          new Date(Date.parse(START) + (5 * 60 + 5) * 1000)
        )
      ).toBe(6);
    });
  });

  describe("running sessions (null completedAt)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("measures a still-running session against the current time", () => {
      vi.setSystemTime(new Date(Date.parse(START) + (10 * 60 + 30) * 1000));
      expect(getDurationScaleMinutes(START, null)).toBe(11);
    });
  });

  describe("missing or unparseable inputs", () => {
    it("returns 1 when startedAt is null", () => {
      expect(getDurationScaleMinutes(null, plus(600))).toBe(1);
    });

    it("returns 1 when startedAt is unparseable", () => {
      expect(getDurationScaleMinutes("not-a-date", plus(600))).toBe(1);
    });

    it("returns 1 when completedAt is unparseable", () => {
      expect(getDurationScaleMinutes(START, "not-a-date")).toBe(1);
    });
  });
});

describe("dateRangeToLookbackDays", () => {
  // FEA-3722: maps the shared date-range selector to a rolling-window day count
  // (or null for the unbounded "all" range) for analytics callers that thread a
  // window size rather than a start-date string.
  it("maps finite ranges to their day count", () => {
    expect(dateRangeToLookbackDays("7d")).toBe(7);
    expect(dateRangeToLookbackDays("30d")).toBe(30);
    expect(dateRangeToLookbackDays("90d")).toBe(90);
  });

  it("maps the all range to null (unbounded)", () => {
    expect(dateRangeToLookbackDays("all")).toBeNull();
  });
});

describe("getStableUtcDateWindowForRange", () => {
  it.each([
    ["7d", "2026-08-01T00:00:00.000Z"],
    ["30d", "2026-07-09T00:00:00.000Z"],
    ["90d", "2026-05-10T00:00:00.000Z"],
  ] as const)("returns the inclusive %s UTC window ending with the current day", (range, startDate) => {
    const window = getStableUtcDateWindowForRange(
      range,
      new Date("2026-08-07T18:43:12.345Z")
    );

    expect(window).toEqual({
      startDate,
      endDate: "2026-08-07T23:59:59.999Z",
    });
    expect(
      Date.parse(window.endDate ?? "") - Date.parse(window.startDate ?? "") + 1
    ).toBe(dateRangeToLookbackDays(range)! * 24 * 60 * 60 * 1000);
  });

  // ISS-5809: the defect this window shipped with. A session active at any point
  // during the in-progress UTC day — including seconds ago — must fall inside the
  // window, or it never reaches the Sessions/Branches list and the newest visible
  // row silently ages all day.
  it("includes activity from the in-progress UTC day", () => {
    const now = new Date("2026-08-10T16:25:26.000Z");
    const window = getStableUtcDateWindowForRange("7d", now);

    expect(Date.parse(window.endDate ?? "")).toBeGreaterThanOrEqual(
      now.getTime()
    );
    // Earlier today, and the very start of today, are both inside it.
    expect(Date.parse(window.startDate ?? "")).toBeLessThanOrEqual(
      Date.parse("2026-08-10T00:00:00.000Z")
    );
  });

  it("keeps same-range values stable throughout one UTC day", () => {
    expect(
      getStableUtcDateWindowForRange(
        "30d",
        new Date("2026-08-07T00:00:00.000Z")
      )
    ).toEqual(
      getStableUtcDateWindowForRange(
        "30d",
        new Date("2026-08-07T23:59:59.999Z")
      )
    );
  });

  it("advances the window at the next UTC day", () => {
    const before = getStableUtcDateWindowForRange(
      "7d",
      new Date("2026-08-07T23:59:59.999Z")
    );
    const after = getStableUtcDateWindowForRange(
      "7d",
      new Date("2026-08-08T00:00:00.000Z")
    );

    expect(
      Date.parse(after.startDate ?? "") - Date.parse(before.startDate ?? "")
    ).toBe(24 * 60 * 60 * 1000);
    expect(
      Date.parse(after.endDate ?? "") - Date.parse(before.endDate ?? "")
    ).toBe(24 * 60 * 60 * 1000);
  });

  it("keeps All unbounded and leaves the rolling helper instant-relative", () => {
    expect(getStableUtcDateWindowForRange("all")).toEqual({});
    expect(
      getStartDateForRange("7d", new Date("2026-08-07T18:43:12.345Z"))
    ).toBe("2026-07-31T18:43:12.345Z");
  });

  it("produces bounds accepted by the Branch cohort contract", () => {
    const window = getStableUtcDateWindowForRange(
      "30d",
      new Date("2026-08-07T18:43:12.345Z")
    );

    expect(
      branchAnalyticsCohortRequestSchema.safeParse({
        branchIds: ["branch-1"],
        ...window,
      }).success
    ).toBe(true);
  });
});

describe("formatLocPerDollar (ISS-4667)", () => {
  it("renders a small non-zero efficiency without flooring to 0.00", () => {
    // The reported session: 4,004 lines / $4,574.72 → 0.875 LOC/$.
    expect(formatLocPerDollar(4004 / 4574.72)).toBe("0.88");
  });

  it("keeps sub-0.01 values readable with significant-digit precision", () => {
    expect(formatLocPerDollar(0.0088)).toBe("0.0088");
    expect(formatLocPerDollar(0.001)).toBe("0.001");
    expect(formatLocPerDollar(0.0088)).not.toBe("0.00");
  });

  it("renders the distinct n/a placeholder when the metric is unavailable", () => {
    expect(formatLocPerDollar(null)).toBe(KPI_NO_VALUE);
    expect(formatLocPerDollar(undefined)).toBe(KPI_NO_VALUE);
    expect(formatLocPerDollar(Number.NaN)).toBe(KPI_NO_VALUE);
    expect(formatLocPerDollar(Number.POSITIVE_INFINITY)).toBe(KPI_NO_VALUE);
  });

  it("renders a genuine zero as 0.00, distinct from the n/a placeholder", () => {
    expect(formatLocPerDollar(0)).toBe("0.00");
  });

  it("uses whole numbers at or above 10 and 2dp below it", () => {
    expect(formatLocPerDollar(5.5)).toBe("5.50");
    expect(formatLocPerDollar(1234.6)).toBe("1,235");
  });
});

describe("formatLocPerDollarColumn (ISS-4866)", () => {
  it("commits to one precision so a sorted column can be scanned", () => {
    // The reported defect: adaptive precision stacks `0.0088` / `0.88` / `12`.
    expect(formatLocPerDollarColumn(0.88)).toBe("0.88");
    expect(formatLocPerDollarColumn(12)).toBe("12.00");
    expect(formatLocPerDollarColumn(5.5)).toBe("5.50");
    expect(formatLocPerDollarColumn(1234.6)).toBe("1,234.60");
  });

  it("marks a real sub-threshold value instead of flooring it to a false 0.00", () => {
    // ISS-4667's lie must not come back through the column's fixed precision.
    expect(formatLocPerDollarColumn(0.0088)).toBe("< 0.01");
    expect(formatLocPerDollarColumn(0.001)).toBe("< 0.01");
    expect(formatLocPerDollarColumn(0.0088)).not.toBe("0.00");
  });

  it("keeps a TRUE zero distinct from a sub-threshold value and from unavailable", () => {
    expect(formatLocPerDollarColumn(0)).toBe("0.00");
    expect(formatLocPerDollarColumn(null)).toBe(KPI_NO_VALUE);
    expect(formatLocPerDollarColumn(undefined)).toBe(KPI_NO_VALUE);
    expect(formatLocPerDollarColumn(Number.NaN)).toBe(KPI_NO_VALUE);
    expect(formatLocPerDollarColumn(Number.POSITIVE_INFINITY)).toBe(
      KPI_NO_VALUE
    );
  });

  it("leaves the single-value KPI formatter adaptive", () => {
    // The two formatters are deliberately different: a card shows one number and
    // earns its precision; a column shows a stack meant to be compared.
    expect(formatLocPerDollar(0.0088)).toBe("0.0088");
    expect(formatLocPerDollar(12)).toBe("12");
  });
});

describe("formatCostPrecise / formatTraceCostPrecise lockstep (ISS-4919)", () => {
  // Review thread. `formatTraceCostPrecise` (`@repo/lib`) is the layer-crossing
  // twin of `formatCostPrecise` (`@repo/app`) — the turn-item projection cannot
  // import the app layer, so the behavior is duplicated rather than re-exported,
  // and its docstring declares the two MUST stay in lockstep. Adding the
  // sub-floor bound to only the app-layer copy broke exactly that: the same
  // session dollars read "< $0.0001" in the branch activity timeline and a flat
  // "$0.00" in the session-detail trace and the collapsed sub-agent box. Two
  // surfaces, one record, two claims. This test is what stops the pair drifting
  // again, since no type or import binds them.
  // Scoped to the sub-thousand band deliberately. The lockstep both docstrings
  // declare is about PRECISION — how small a cost may get before the formatter
  // stops showing a figure — and that is the band this change touched. At and
  // above $1,000 the two already differ for an unrelated, pre-existing reason
  // (see the divergence test below), so widening these samples would assert a
  // property the twins have never held and turn a real guard into a red herring.
  const SAMPLES = [
    0, 0.000_000_1, 0.000_01, 0.000_049, 0.000_05, 0.0001, 0.0012, 0.004, 0.005,
    0.0099, 0.01, 0.12, 0.42, 1, 9.99, 999.99, -0.000_01, -0.004, -0.42, -12.5,
  ];

  it.each(SAMPLES)("agrees on %p across the layer boundary", (value) => {
    expect(formatTraceCostPrecise(value)).toBe(formatCostPrecise(value));
  });

  it("records the one PRE-EXISTING divergence: thousands grouping", () => {
    // Not introduced here and not fixed here — pinned so it is a known, bounded
    // gap rather than a surprise the next person reads as this change's fault.
    // `formatTraceCostUsd` is `toFixed(2)` (no grouping); `formatCost` uses
    // `toLocaleString` (grouped). At four figures the same trace cost reads
    // "$1234.56" in the session trace and "$1,234.56" in the branch timeline.
    // Cosmetic, above the band this change is about, and its own fix.
    expect(formatTraceCostPrecise(1234.56)).toBe("$1234.56");
    expect(formatCostPrecise(1234.56)).toBe("$1,234.56");
  });

  it("never lets a nonzero cost render as an exact zero on either side", () => {
    // The guarantee both docstrings state. `formatTraceCostForDisplay` also
    // promised a real sub-cent cost never collapses into the same "$0.00" as a
    // sub-agent with no cost data — which was false in exactly this band.
    for (const value of [0.000_000_1, 0.000_01, 0.000_049]) {
      expect(formatTraceCostPrecise(value)).not.toBe("$0.00");
      expect(formatCostPrecise(value)).not.toBe("$0.00");
      expect(formatTraceCostForDisplay(value)).not.toBe("$0.00");
    }
    // A genuine zero still reads as one, so the two states stay distinguishable.
    expect(formatTraceCostPrecise(0)).toBe("$0.00");
    // And a truly absent cost is a third state, not either of the above.
    expect(formatTraceCostForDisplay(null)).toBeNull();
  });
});
