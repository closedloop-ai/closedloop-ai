import { describe, expect, it } from "vitest";
import { lifespanHistogram, pctDelta, ttmHistogram } from "./insights";

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
