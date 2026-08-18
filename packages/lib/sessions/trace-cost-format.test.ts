import { describe, expect, it } from "vitest";
import {
  formatTraceCostForDisplay,
  formatTraceCostPrecise,
  formatTraceCostUsd,
} from "./trace-cost-format.ts";

describe("formatTraceCostUsd — fixed 2dp SSOT", () => {
  it("renders a cent-scale value at fixed 2dp", () => {
    expect(formatTraceCostUsd(0.42)).toBe("$0.42");
  });

  it("floors a sub-half-cent value to $0.00 (the imprecise display the precise formatter guards against)", () => {
    expect(formatTraceCostUsd(0.003)).toBe("$0.00");
  });
});

describe("formatTraceCostPrecise — sub-cent trace cost", () => {
  it("renders a sub-cent nonzero value with extra precision instead of a floored $0.00", () => {
    expect(formatTraceCostPrecise(0.003)).toBe("$0.003");
  });

  it("distinguishes two distinct sub-cent values that fixed-2dp would collapse to the same $0.00", () => {
    expect(formatTraceCostPrecise(0.003)).not.toBe(
      formatTraceCostPrecise(0.006)
    );
  });

  it("states a bound below the 4dp floor rather than a fabricated zero", () => {
    // ISS-4919 (review thread). This test previously pinned "$0.00" here — the
    // behavior the app-layer twin `formatCostPrecise` had already stopped
    // producing. That divergence was the defect: the SAME session dollars read
    // "< $0.0001" in the branch activity timeline and a flat "$0.00" in the
    // session-detail trace and the collapsed sub-agent box. Two surfaces, one
    // record, two claims.
    //
    // Below the 4dp floor no figure is faithful, so the honest statement is a
    // bound, not a rounded-down zero. A truly negligible slice is still not
    // given false precision — it is given the truth about its own magnitude.
    expect(formatTraceCostPrecise(0.000_001)).toBe("< $0.0001");
    expect(formatTraceCostPrecise(0.000_001)).not.toBe("$0.00");
    // The negative mirror, so a credit below the floor reads as its own bound.
    expect(formatTraceCostPrecise(-0.000_001)).toBe("> -$0.0001");
  });

  it("keeps an exact zero distinct from a rounded-down nonzero", () => {
    // The whole point of the bound: "free" and "too small to show" must never
    // render the same string.
    expect(formatTraceCostPrecise(0)).toBe("$0.00");
    expect(formatTraceCostPrecise(0)).not.toBe(
      formatTraceCostPrecise(0.000_001)
    );
  });

  it("renders a cent-or-more value identically to the fixed-2dp formatter", () => {
    expect(formatTraceCostPrecise(0.42)).toBe(formatTraceCostUsd(0.42));
  });

  it("renders exact zero identically to the fixed-2dp formatter", () => {
    expect(formatTraceCostPrecise(0)).toBe("$0.00");
  });
});

describe("formatTraceCostForDisplay — present-vs-absent distinction", () => {
  it("returns null only when the cost is genuinely absent so the box drops the empty part", () => {
    expect(formatTraceCostForDisplay(null)).toBeNull();
  });

  it("renders a present sub-cent cost precisely rather than as null or a floored $0.00", () => {
    expect(formatTraceCostForDisplay(0.003)).toBe("$0.003");
  });

  it("renders a present zero cost as $0.00, distinct from the null 'no data' state", () => {
    expect(formatTraceCostForDisplay(0)).toBe("$0.00");
  });
});
