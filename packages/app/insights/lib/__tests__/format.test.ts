import { KpiFormat } from "@repo/api/src/types/insights";
import { describe, expect, it } from "vitest";
import { deltaIsPositive, formatDelta, formatKpiValue } from "../format";

describe("formatKpiValue", () => {
  it("formats currency under and over a thousand", () => {
    expect(formatKpiValue(28, KpiFormat.Currency)).toBe("$28");
    expect(formatKpiValue(4.2, KpiFormat.Currency)).toBe("$4.20");
    expect(formatKpiValue(36_412, KpiFormat.Currency)).toBe("$36.4k");
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
});

describe("formatDelta", () => {
  it("returns null when there is no delta", () => {
    expect(formatDelta(null)).toBeNull();
  });

  it("signs positive and negative deltas", () => {
    expect(formatDelta(12)).toBe("+12%");
    expect(formatDelta(-7)).toBe("-7%");
  });

  it("classifies direction, treating null as non-negative", () => {
    expect(deltaIsPositive(5)).toBe(true);
    expect(deltaIsPositive(-1)).toBe(false);
    expect(deltaIsPositive(null)).toBe(true);
  });
});
