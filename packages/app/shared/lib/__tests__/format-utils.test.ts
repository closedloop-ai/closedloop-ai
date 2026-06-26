import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatCost,
  formatNumber,
  formatTokenCount,
  getDurationScaleMinutes,
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
