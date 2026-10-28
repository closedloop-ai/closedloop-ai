import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  displayableBranchMetricValue,
  isDisplayableBranchMetricNumber,
  shippedClampedBranchMetricValue,
} from "../branch-metric-value";

describe("branch metric display value helpers", () => {
  it("accepts finite non-negative numbers within the JSON-safe range", () => {
    expect(isDisplayableBranchMetricNumber(0)).toBe(true);
    expect(isDisplayableBranchMetricNumber(0.5)).toBe(true);
    expect(isDisplayableBranchMetricNumber(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("rejects absent, negative, non-finite, and unsafe-size numbers", () => {
    expect(isDisplayableBranchMetricNumber(null)).toBe(false);
    expect(isDisplayableBranchMetricNumber(undefined)).toBe(false);
    expect(isDisplayableBranchMetricNumber(-1)).toBe(false);
    expect(isDisplayableBranchMetricNumber(Number.NaN)).toBe(false);
    expect(isDisplayableBranchMetricNumber(Number.POSITIVE_INFINITY)).toBe(
      false
    );
    expect(isDisplayableBranchMetricNumber(Number.MAX_SAFE_INTEGER + 1)).toBe(
      false
    );
  });

  it("extracts complete and partial metric values with the partial marker", () => {
    expect(displayableBranchMetricValue(complete(42))).toEqual({
      partial: false,
      value: 42,
    });
    // EXPECTATION CHANGED by ISS-8551: a Partial value now leaves with the
    // sentence the producer attached to it, so a surface never picks one. The
    // Complete arm above still carries none, which is what keeps the two states
    // distinguishable by shape rather than by a flag alone.
    expect(displayableBranchMetricValue(partial(3.5))).toEqual({
      partial: true,
      value: 3.5,
      disclosure: BranchMetricDisclosure.DefaultIncomplete,
    });
  });

  it("withholds unavailable and invalid metric results", () => {
    expect(displayableBranchMetricValue(undefined)).toBeNull();
    expect(displayableBranchMetricValue(unavailable())).toBeNull();
    expect(displayableBranchMetricValue(complete(1e308))).toBeNull();
  });

  it("preserves the shipped clamped metric path for flag-off consumers", () => {
    expect(shippedClampedBranchMetricValue(complete(-1))).toEqual({
      partial: false,
      value: 0,
    });
    expect(shippedClampedBranchMetricValue(partial(1))).toEqual({
      partial: true,
      value: 1,
      disclosure: BranchMetricDisclosure.DefaultIncomplete,
    });
    expect(shippedClampedBranchMetricValue(unavailable())).toBeNull();
  });
});

function complete(value: number): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Complete, value };
}

function partial(value: number): BranchMetricResult<number> {
  return {
    state: BranchMetricAvailability.Partial,
    value,
    disclosure: BranchMetricDisclosure.DefaultIncomplete,
  };
}

function unavailable(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Unavailable, value: null };
}
