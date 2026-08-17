import { describe, expect, it } from "vitest";
import { isAnomalousSpendTotal, reportableSpendUsd } from "./spend-kpi";

/**
 * ISS-4737 — the null-on-zero rule the three AI-spend producers share. Each
 * producer has its own regression covering the zero-sum case end to end
 * (`branch-read-service`, `branch-analytics-projection`,
 * `filtered-branch-analytics`); this pins the rule itself so a future edit
 * cannot quietly loosen it for all three at once.
 */
describe("reportableSpendUsd", () => {
  it("reports a positive total unchanged", () => {
    expect(reportableSpendUsd(12.34)).toBe(12.34);
  });

  it("reports a tiny positive total rather than rounding it away", () => {
    expect(reportableSpendUsd(0.000_01)).toBe(0.000_01);
  });

  it("returns null for a priced total that sums to exactly zero", () => {
    expect(reportableSpendUsd(0)).toBeNull();
  });

  it("returns null for a negative total (never a fabricated figure)", () => {
    expect(reportableSpendUsd(-5)).toBeNull();
  });

  it("returns null when nothing priced", () => {
    expect(reportableSpendUsd(null)).toBeNull();
    expect(reportableSpendUsd(undefined)).toBeNull();
  });

  it("returns null for a non-finite total rather than rendering NaN/∞", () => {
    expect(reportableSpendUsd(Number.NaN)).toBeNull();
    expect(reportableSpendUsd(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

/**
 * ISS-4737 (#4244 review) — the anomaly half. `reportableSpendUsd` collapses a
 * corrupt total into the SAME `null` a legitimate no-data corpus produces, so
 * this predicate is what keeps the two distinguishable for the Node producers'
 * monitored logs. It must fire on exactly the impossible values and stay silent
 * on the ordinary ones, or the signal is noise.
 */
describe("isAnomalousSpendTotal", () => {
  it("flags a negative total", () => {
    expect(isAnomalousSpendTotal(-5)).toBe(true);
    expect(isAnomalousSpendTotal(-0.000_01)).toBe(true);
  });

  it("flags a non-finite total", () => {
    expect(isAnomalousSpendTotal(Number.NaN)).toBe(true);
    expect(isAnomalousSpendTotal(Number.POSITIVE_INFINITY)).toBe(true);
    expect(isAnomalousSpendTotal(Number.NEGATIVE_INFINITY)).toBe(true);
  });

  it("stays silent on an absent total (nothing priced)", () => {
    expect(isAnomalousSpendTotal(null)).toBe(false);
    expect(isAnomalousSpendTotal(undefined)).toBe(false);
  });

  it("stays silent on an exact zero — unreportable, but not corrupt", () => {
    expect(isAnomalousSpendTotal(0)).toBe(false);
    expect(isAnomalousSpendTotal(-0)).toBe(false);
  });

  it("stays silent on any ordinary positive total", () => {
    expect(isAnomalousSpendTotal(12.34)).toBe(false);
    expect(isAnomalousSpendTotal(0.000_01)).toBe(false);
  });
});
