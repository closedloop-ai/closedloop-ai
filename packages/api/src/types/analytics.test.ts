import { describe, expect, it } from "vitest";
import {
  BaselineSampleCoverage,
  MergedPrsCoverage,
  resolveBaselineSampleCoverage,
  resolveMergedPrsCoverage,
} from "./analytics.ts";

describe("resolveMergedPrsCoverage", () => {
  it("resolves true to Capped", () => {
    expect(resolveMergedPrsCoverage(true)).toBe(MergedPrsCoverage.Capped);
  });

  it("resolves false to WholeCohort", () => {
    expect(resolveMergedPrsCoverage(false)).toBe(MergedPrsCoverage.WholeCohort);
  });

  it("resolves undefined to Unknown", () => {
    expect(resolveMergedPrsCoverage(undefined)).toBe(MergedPrsCoverage.Unknown);
  });
});

describe("resolveBaselineSampleCoverage", () => {
  it("resolves null to WholeWindow", () => {
    expect(resolveBaselineSampleCoverage(null)).toBe(
      BaselineSampleCoverage.WholeWindow
    );
  });

  it("resolves undefined to Unknown", () => {
    expect(resolveBaselineSampleCoverage(undefined)).toBe(
      BaselineSampleCoverage.Unknown
    );
  });

  it("resolves a positive integer to Sampled", () => {
    expect(resolveBaselineSampleCoverage(5)).toBe(
      BaselineSampleCoverage.Sampled
    );
  });

  it("resolves zero to Unknown", () => {
    expect(resolveBaselineSampleCoverage(0)).toBe(
      BaselineSampleCoverage.Unknown
    );
  });

  it("resolves a negative integer to Unknown", () => {
    expect(resolveBaselineSampleCoverage(-3)).toBe(
      BaselineSampleCoverage.Unknown
    );
  });

  it("resolves a fractional value to Unknown", () => {
    expect(resolveBaselineSampleCoverage(1.5)).toBe(
      BaselineSampleCoverage.Unknown
    );
  });

  it("resolves a non-finite value to Unknown", () => {
    expect(resolveBaselineSampleCoverage(Number.POSITIVE_INFINITY)).toBe(
      BaselineSampleCoverage.Unknown
    );
  });
});
