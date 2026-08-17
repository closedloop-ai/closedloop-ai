import { MAX_DELTA_PCT } from "@closedloop-ai/loops-api/insights";
import { KpiFormat } from "@repo/api/src/types/insights";
import { formatCurrencyWhole } from "@repo/app/shared/lib/format-utils";
import { describe, expect, it } from "vitest";
import {
  formatDelta,
  formatKpiTileValue,
  formatKpiValue,
  metricAllowsFractions,
  metricValueFormatter,
} from "../format";

describe("formatKpiValue", () => {
  it("formats currency under and over a thousand", () => {
    expect(formatKpiValue(28, KpiFormat.Currency)).toBe("$28");
    expect(formatKpiValue(4.2, KpiFormat.Currency)).toBe("$4.20");
    expect(formatKpiValue(36_412, KpiFormat.Currency)).toBe("$36.4k");
  });

  it("renders — for an unavailable (null / non-finite) value, not 0", () => {
    // Median PR size uses a non-finite sentinel when no PR in the window is
    // LOC-enriched (NaN in-process, null over JSON). Render `—`, never `0`.
    expect(formatKpiValue(null, KpiFormat.Number)).toBe("—");
    expect(formatKpiValue(undefined, KpiFormat.Number)).toBe("—");
    expect(formatKpiValue(Number.NaN, KpiFormat.Number)).toBe("—");
    expect(formatKpiValue(Number.POSITIVE_INFINITY, KpiFormat.Currency)).toBe(
      "—"
    );
    // A real 0 still formats as 0 (not swallowed into —).
    expect(formatKpiValue(0, KpiFormat.Number)).toBe("0");
  });

  it("formats percent as a rounded integer", () => {
    expect(formatKpiValue(86.6, KpiFormat.Percent)).toBe("87%");
  });

  it("compacts token counts", () => {
    expect(formatKpiValue(24_100_000_000, KpiFormat.Tokens)).toBe("24.1B");
    expect(formatKpiValue(1800, KpiFormat.Tokens)).toBe("1.8k");
  });

  it("humanizes durations and shows a dash for zero", () => {
    expect(formatKpiValue(0, KpiFormat.Duration)).toBe("—");
    expect(
      formatKpiValue(3_600_000 * 3 + 60_000 * 54, KpiFormat.Duration)
    ).toBe("3h 54m");
    expect(formatKpiValue(120_000, KpiFormat.Duration)).toBe("2m");
  });

  it("formats plain numbers with grouping separators", () => {
    expect(formatKpiValue(84, KpiFormat.Number)).toBe("84");
    expect(formatKpiValue(2960, KpiFormat.Number)).toBe("2,960");
    expect(formatKpiValue(2960.45, KpiFormat.Number)).toBe("2,960.5");
  });

  it("pins currency tier boundaries: <10 gets 2dp, >=10 gets 0dp, >=1000 compacts", () => {
    expect(formatKpiValue(9.99, KpiFormat.Currency)).toBe("$9.99");
    // exactly at the <10 / >=10 boundary: no fractional part
    expect(formatKpiValue(10, KpiFormat.Currency)).toBe("$10");
    expect(formatKpiValue(999, KpiFormat.Currency)).toBe("$999");
    // exactly at the compact boundary
    expect(formatKpiValue(1000, KpiFormat.Currency)).toBe("$1k");
    expect(formatKpiValue(1234.56, KpiFormat.Currency)).toBe("$1.2k");
  });

  it("pins negative currency: $ prefix precedes the minus sign", () => {
    // Contract pin: formatCurrency places $ before the sign, yielding "$-5.50".
    expect(formatKpiValue(-5.5, KpiFormat.Currency)).toBe("$-5.50");
  });

  it("pins token compact tier boundaries at k, M, and B", () => {
    expect(formatKpiValue(999, KpiFormat.Tokens)).toBe("999");
    expect(formatKpiValue(1000, KpiFormat.Tokens)).toBe("1k");
    expect(formatKpiValue(1500, KpiFormat.Tokens)).toBe("1.5k");
    // 999_999 < 1_000_000, but 999999/1000 = 999.999 rounds up at 1dp, so the
    // tier-carry guard promotes it to the M tier rather than render "1000k".
    expect(formatKpiValue(999_999, KpiFormat.Tokens)).toBe("1M");
    expect(formatKpiValue(1_000_000, KpiFormat.Tokens)).toBe("1M");
    expect(formatKpiValue(1_000_000_000, KpiFormat.Tokens)).toBe("1B");
  });

  it("pins duration boundaries: h crossover at exactly 3600000ms, sub-minute clamps to 1m", () => {
    // Exactly at the hour boundary: no remainder minutes
    expect(formatKpiValue(3_600_000, KpiFormat.Duration)).toBe("1h 0m");
    // Just below: stays in the minutes branch
    expect(formatKpiValue(59 * 60_000, KpiFormat.Duration)).toBe("59m");
    // Just above: crosses into the hours branch
    expect(formatKpiValue(61 * 60_000, KpiFormat.Duration)).toBe("1h 1m");
    // Sub-minute positive duration clamps to the minimum display unit of 1m
    expect(formatKpiValue(30_000, KpiFormat.Duration)).toBe("1m");
  });

  it("carries a 60-minute remainder into the next hour instead of '1h 60m'", () => {
    // 1h 59.5m: the minute remainder rounds up to 60 and must carry to 2h 0m
    expect(formatKpiValue(7_170_000, KpiFormat.Duration)).toBe("2h 0m");
    // Sub-hour carry: 59.5m rounds to 60m and must render as 1h 0m, not "60m"
    expect(formatKpiValue(3_570_000, KpiFormat.Duration)).toBe("1h 0m");
  });

  it("rounds percent to nearest integer (half rounds up; negative half rounds toward +infinity)", () => {
    expect(formatKpiValue(0.5, KpiFormat.Percent)).toBe("1%");
    // Math.round(-7.5) = -7 in JS (rounds toward +infinity)
    expect(formatKpiValue(-7.5, KpiFormat.Percent)).toBe("-7%");
  });

  it("formats numbers with 1dp max and en-US grouping separators", () => {
    // maximumFractionDigits:1 rounds the second decimal: 1234.56 → 1,234.6
    expect(formatKpiValue(1234.56, KpiFormat.Number)).toBe("1,234.6");
  });
});

describe("formatKpiTileValue (FEA-3431 whole-dollar aggregate spend)", () => {
  it("renders an aggregate spend KPI as whole dollars, not compact $9.1k", () => {
    // The gap #3001 left open: the Insights headline spend read "$9.1k" while
    // the Branches/Sessions "AI spend" card read "$9,061" for the same amount.
    expect(formatKpiTileValue(9060.84, KpiFormat.Currency)).toBe("$9,061");
    // …and the compact form that formatKpiValue would have produced is gone.
    expect(formatKpiValue(9060.84, KpiFormat.Currency)).toBe("$9.1k");
  });

  it("matches the Branches/Sessions card formatter for the same magnitude", () => {
    // Cross-surface consistency: the Insights KPI and the Branches/Sessions
    // summary card (which uses formatCurrencyWhole directly) format identically.
    for (const amount of [9060.84, 42, 1234.56, 1_000_000, 0.12]) {
      expect(formatKpiTileValue(amount, KpiFormat.Currency)).toBe(
        formatCurrencyWhole(amount)
      );
    }
  });

  it("rounds to whole dollars with a thousands separator and no cents", () => {
    expect(formatKpiTileValue(28, KpiFormat.Currency)).toBe("$28");
    expect(formatKpiTileValue(999, KpiFormat.Currency)).toBe("$999");
    // No precision cliff: >=1000 keeps every digit, no compact "k".
    expect(formatKpiTileValue(1000, KpiFormat.Currency)).toBe("$1,000");
    expect(formatKpiTileValue(1234.56, KpiFormat.Currency)).toBe("$1,235");
  });

  it("preserves the honest-empty — for null / non-finite, never $0", () => {
    expect(formatKpiTileValue(null, KpiFormat.Currency)).toBe("—");
    expect(formatKpiTileValue(undefined, KpiFormat.Currency)).toBe("—");
    expect(formatKpiTileValue(Number.NaN, KpiFormat.Currency)).toBe("—");
    expect(
      formatKpiTileValue(Number.POSITIVE_INFINITY, KpiFormat.Currency)
    ).toBe("—");
  });

  it("keeps cents for a genuinely sub-dollar aggregate (never a flat $0)", () => {
    // A low-usage dashboard whose real spend rounds to <$1 still shows cents,
    // mirroring formatCurrencyWhole's sub-dollar guard.
    expect(formatKpiTileValue(0.12, KpiFormat.Currency)).toBe("$0.12");
  });

  it("delegates non-currency formats to formatKpiValue unchanged", () => {
    expect(formatKpiTileValue(86.6, KpiFormat.Percent)).toBe("87%");
    expect(formatKpiTileValue(1800, KpiFormat.Tokens)).toBe("1.8k");
    expect(formatKpiTileValue(2960, KpiFormat.Number)).toBe("2,960");
    expect(formatKpiTileValue(120_000, KpiFormat.Duration)).toBe("2m");
    expect(formatKpiTileValue(null, KpiFormat.Number)).toBe("—");
  });
});

describe("metricValueFormatter", () => {
  it("formats the cost metric as currency (FEA-2331 spend-by-model)", () => {
    const fmt = metricValueFormatter("cost");
    expect(fmt(4.2)).toBe("$4.20");
    expect(fmt(5016.61)).toBe("$5k");
  });

  it("compacts the tokens metric", () => {
    expect(metricValueFormatter("tokens")(1800)).toBe("1.8k");
  });

  it("falls back to plain numbers for unknown metrics", () => {
    expect(metricValueFormatter("models")(2960)).toBe("2,960");
  });
});

describe("metricAllowsFractions", () => {
  it("allows fractional ticks for currency (sub-dollar spend), not counts", () => {
    expect(metricAllowsFractions("cost")).toBe(true);
    expect(metricAllowsFractions("tokens")).toBe(false);
    expect(metricAllowsFractions("models")).toBe(false);
  });
});

describe("formatDelta", () => {
  it("returns null when there is no delta", () => {
    expect(formatDelta(null)).toBeNull();
  });

  it("signs positive and negative deltas", () => {
    expect(formatDelta(12)).toBe("+12%");
    expect(formatDelta(-7)).toBe("-7%");
  });

  it("renders a ceiling-capped delta with the comparison glyph (FEA-3959)", () => {
    // A delta AT the display ceiling reads ">999%" / "<-999%" — the glyph
    // carries direction and signals "at least this much", rather than the
    // typo-looking "+999%+" / "-999%+". Since ISS-5003 `pctDelta` returns null
    // past the ceiling instead of clamping to it, so this is the version-skew
    // path: a ±999 minted by an older producer still renders sanely.
    expect(formatDelta(MAX_DELTA_PCT)).toBe(`>${MAX_DELTA_PCT}%`);
    expect(formatDelta(-MAX_DELTA_PCT)).toBe(`<-${MAX_DELTA_PCT}%`);
    // A sub-ceiling delta carries the plain signed percent.
    expect(formatDelta(MAX_DELTA_PCT - 1)).toBe(`+${MAX_DELTA_PCT - 1}%`);
  });
});
