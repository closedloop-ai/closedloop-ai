import { describe, expect, it } from "vitest";
import {
  AUTONOMY_BAND_CUTPOINTS,
  AutonomyBand,
  asAutonomyBand,
  autonomyBandFor,
  SpendConfidenceTier,
  UNKNOWN_SESSION_ACTIVITY_METRICS,
} from "./session-activity-metrics";
import { normalizeSessionActivityMetrics } from "./session-activity-metrics-normalize";

/**
 * The band and tier members written out as NON-CIRCULAR literals.
 *
 * Building this list from `Object.values(AutonomyBand)` would agree with the
 * const under every mutation it exists to catch: deleting a member, renaming
 * one, or adding one nobody specified all stay green. The duplication IS the
 * test — these are the desktop's stored `session_activity_metrics.autonomy_band`
 * values, and changing one is a data migration, not an edit.
 */
const EXPECTED_AUTONOMY_BANDS = ["human_steered", "mixed", "agentic"];
const EXPECTED_SPEND_CONFIDENCE_TIERS = ["low", "medium", "high"];

describe("autonomy band vocabulary", () => {
  it("is exactly the three stored members, in no more and no fewer", () => {
    expect(Object.values(AutonomyBand).sort()).toEqual(
      [...EXPECTED_AUTONOMY_BANDS].sort()
    );
  });

  it("is exactly the three stored confidence tiers", () => {
    expect(Object.values(SpendConfidenceTier).sort()).toEqual(
      [...EXPECTED_SPEND_CONFIDENCE_TIERS].sort()
    );
  });

  it("bands each side of BOTH cut-points, on the boundary itself", () => {
    const lower = AUTONOMY_BAND_CUTPOINTS.humanSteeredMaxExclusive;
    const upper = AUTONOMY_BAND_CUTPOINTS.agenticMinInclusive;
    expect(autonomyBandFor(lower - 1)).toBe(AutonomyBand.HumanSteered);
    // Exclusive lower bound: the cut-point value itself is already `mixed`.
    expect(autonomyBandFor(lower)).toBe(AutonomyBand.Mixed);
    expect(autonomyBandFor(upper - 1)).toBe(AutonomyBand.Mixed);
    // Inclusive upper bound: the cut-point value itself is already `agentic`.
    expect(autonomyBandFor(upper)).toBe(AutonomyBand.Agentic);
  });

  it("reads an unrecognized stored band as unknown, not as a band", () => {
    expect(asAutonomyBand("supervised")).toBeNull();
    expect(asAutonomyBand(null)).toBeNull();
    expect(asAutonomyBand(AutonomyBand.Agentic)).toBe(AutonomyBand.Agentic);
  });
});

describe("unknown is never zero", () => {
  it("reads an absent rollup as null throughout, never as a measurement", () => {
    const metrics = normalizeSessionActivityMetrics(null);
    expect(metrics).toEqual(UNKNOWN_SESSION_ACTIVITY_METRICS);
    // Stated separately from the object comparison: these three are the values
    // an unmeasured session would be LIBELLED with if a default leaked in.
    expect(metrics.coverage).toBeNull();
    expect(metrics.segmentCount).toBeNull();
    expect(metrics.autonomyBand).toBeNull();
  });

  it("keeps a genuinely measured zero, which is not the same claim", () => {
    const metrics = normalizeSessionActivityMetrics({
      coverage: 0,
      segmentCount: 0,
      coveredSegmentCount: 0,
      spendLowConfUsd: 0,
      spendMediumConfUsd: 0,
      spendHighConfUsd: 0,
    });
    expect(metrics.coverage).toBe(0);
    expect(metrics.segmentCount).toBe(0);
    expect(metrics.spendHighConfUsd).toBe(0);
  });
});

describe("the validity predicate covers the whole impossible set", () => {
  it("refuses a blank string rather than measuring it as zero", () => {
    // `Number("")` is 0, so a coerce-first predicate reports a confident
    // 0% coverage for a field that carried nothing.
    const metrics = normalizeSessionActivityMetrics({
      coverage: "",
      segmentCount: "",
    });
    expect(metrics.coverage).toBeNull();
    expect(metrics.segmentCount).toBeNull();
  });

  it("refuses a fractional count, a negative, and a non-finite value", () => {
    expect(
      normalizeSessionActivityMetrics({ segmentCount: 1.5 }).segmentCount
    ).toBeNull();
    expect(
      normalizeSessionActivityMetrics({ segmentCount: -1 }).segmentCount
    ).toBeNull();
    expect(
      normalizeSessionActivityMetrics({ coverage: Number.NaN }).coverage
    ).toBeNull();
    expect(
      normalizeSessionActivityMetrics({
        spendHighConfUsd: Number.POSITIVE_INFINITY,
      }).spendHighConfUsd
    ).toBeNull();
  });

  it("clamps coverage at BOTH ends, not only below", () => {
    expect(normalizeSessionActivityMetrics({ coverage: 1 }).coverage).toBe(1);
    expect(
      normalizeSessionActivityMetrics({ coverage: 1.01 }).coverage
    ).toBeNull();
    expect(
      normalizeSessionActivityMetrics({ coverage: -0.01 }).coverage
    ).toBeNull();
  });

  it("refuses a count past the safe-integer range", () => {
    expect(
      normalizeSessionActivityMetrics({
        segmentCount: Number.MAX_SAFE_INTEGER + 2,
      }).segmentCount
    ).toBeNull();
  });

  it("refuses a covered count larger than the population it is drawn from", () => {
    const metrics = normalizeSessionActivityMetrics({
      segmentCount: 4,
      coveredSegmentCount: 5,
    });
    expect(metrics.segmentCount).toBe(4);
    expect(metrics.coveredSegmentCount).toBeNull();
  });

  it("withholds the WHOLE spend split when one tier is impossible", () => {
    // Publishing the surviving two would not narrow the sample — a reader
    // summing them gets an understated attributed total and every share drawn
    // from it reads larger than it is. The band and the counts are unaffected,
    // because their shortfall would narrow rather than bias.
    const metrics = normalizeSessionActivityMetrics({
      autonomyBand: AutonomyBand.Mixed,
      segmentCount: 9,
      spendLowConfUsd: 1.5,
      spendMediumConfUsd: -2,
      spendHighConfUsd: 3.25,
    });
    expect(metrics.spendLowConfUsd).toBeNull();
    expect(metrics.spendMediumConfUsd).toBeNull();
    expect(metrics.spendHighConfUsd).toBeNull();
    expect(metrics.autonomyBand).toBe(AutonomyBand.Mixed);
    expect(metrics.segmentCount).toBe(9);
  });

  it("publishes a whole, valid split", () => {
    const metrics = normalizeSessionActivityMetrics({
      spendLowConfUsd: 1.5,
      spendMediumConfUsd: 2,
      spendHighConfUsd: 3.25,
    });
    expect(metrics.spendLowConfUsd).toBe(1.5);
    expect(metrics.spendMediumConfUsd).toBe(2);
    expect(metrics.spendHighConfUsd).toBe(3.25);
  });
});
