import { describe, expect, it } from "vitest";
import {
  SessionMeshSavingsPercentile,
  type SessionMeshTripsSaved,
  sessionMeshSavings,
  sessionMeshSavingsValidator,
  sessionMeshTripsSavedValidator,
} from "../session-mesh-savings";

const trips: SessionMeshTripsSaved = {
  median: 7,
  mean: 16.3,
  p90: 40,
  observations: 1944,
};

describe("sessionMeshSavings", () => {
  it("projects each percentile as deliveries x trips x cost", () => {
    const result = sessionMeshSavings({
      engagedDeliveries: 100,
      tripsSaved: trips,
      costPerRoundTripUsd: 0.43,
    });
    expect(result.median).toBeCloseTo(100 * 7 * 0.43, 10);
    expect(result.mean).toBeCloseTo(100 * 16.3 * 0.43, 10);
    expect(result.p90).toBeCloseTo(100 * 40 * 0.43, 10);
  });

  it("scales with the multiplier it is given and echoes it back", () => {
    // This function has no concept of "engaged" — it multiplies whatever it is
    // passed, so this pins proportionality and the echoed denominator only.
    // That the CALLER passes the engaged count rather than every delivery is
    // pinned at the call site, by insights.branches.test.ts's
    // "multiplies savings over ENGAGED deliveries, not every delivery".
    const ten = sessionMeshSavings({
      engagedDeliveries: 10,
      tripsSaved: trips,
      costPerRoundTripUsd: 0.43,
    });
    const hundred = sessionMeshSavings({
      engagedDeliveries: 100,
      tripsSaved: trips,
      costPerRoundTripUsd: 0.43,
    });
    expect(hundred.median as number).toBeCloseTo(
      (ten.median as number) * 10,
      10
    );
    expect(ten.engagedDeliveries).toBe(10);
  });

  it("reports null, never zero, when the round-trip price is unknown", () => {
    const result = sessionMeshSavings({
      engagedDeliveries: 500,
      tripsSaved: trips,
      costPerRoundTripUsd: null,
    });
    expect(result.median).toBeNull();
    expect(result.mean).toBeNull();
    expect(result.p90).toBeNull();
    expect(result.costPerRoundTripUsd).toBeNull();
    // The multiplier survives so the card can still state its denominator.
    expect(result.engagedDeliveries).toBe(500);
  });

  it("reports null per-percentile when only that percentile is unknown", () => {
    const result = sessionMeshSavings({
      engagedDeliveries: 100,
      tripsSaved: { median: 7, mean: null, p90: 40, observations: 12 },
      costPerRoundTripUsd: 0.43,
    });
    expect(result.median).not.toBeNull();
    expect(result.mean).toBeNull();
    expect(result.p90).not.toBeNull();
  });

  it("carries the trips-saved observation count so no figure is bare", () => {
    const result = sessionMeshSavings({
      engagedDeliveries: 100,
      tripsSaved: trips,
      costPerRoundTripUsd: 0.43,
    });
    expect(result.tripsSaved.observations).toBe(1944);
  });

  it("yields a true zero only when nothing was engaged", () => {
    const result = sessionMeshSavings({
      engagedDeliveries: 0,
      tripsSaved: trips,
      costPerRoundTripUsd: 0.43,
    });
    expect(result.median).toBe(0);
    expect(result.engagedDeliveries).toBe(0);
  });

  it.each([
    ["negative deliveries", -20],
    ["fractional deliveries", 12.7],
    ["non-finite deliveries", Number.NaN],
    ["infinite deliveries", Number.POSITIVE_INFINITY],
    ["absent deliveries", null],
  ])(
    "reports %s as an unknown multiplier, never as a free projection",
    (_label, deliveries) => {
      const result = sessionMeshSavings({
        engagedDeliveries: deliveries as number | null,
        tripsSaved: trips,
        costPerRoundTripUsd: 0.43,
      });
      // A corrupt count is a genuinely absent operand, so the projection is
      // unknown. Clamping it to 0 published "$0.00 saved" — a measurement
      // nobody took.
      expect(result.engagedDeliveries).toBeNull();
      expect(result.median).toBeNull();
      expect(result.mean).toBeNull();
      expect(result.p90).toBeNull();
      // The measured price is a separate operand and still publishes.
      expect(result.costPerRoundTripUsd).toBeCloseTo(0.43, 10);
      expect(() => sessionMeshSavingsValidator.parse(result)).not.toThrow();
    }
  );

  it.each([
    ["negative", -1],
    ["non-finite", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])(
    "echoes a %s trips-saved entry back as unknown, not as itself",
    (_label, median) => {
      const result = sessionMeshSavings({
        engagedDeliveries: 100,
        tripsSaved: { median, mean: 16.3, p90: 40, observations: 1944 },
        costPerRoundTripUsd: 0.43,
      });
      expect(result.tripsSaved.median).toBeNull();
      expect(result.median).toBeNull();
      // The usable percentiles beside it still publish.
      expect(result.mean).toBeCloseTo(100 * 16.3 * 0.43, 10);
      expect(() => sessionMeshSavingsValidator.parse(result)).not.toThrow();
    }
  );

  it.each([
    ["negative observations", -5],
    ["fractional observations", 2.5],
    ["non-finite observations", Number.NaN],
  ])("echoes %s back as an unknown denominator", (_label, observations) => {
    const result = sessionMeshSavings({
      engagedDeliveries: 100,
      tripsSaved: { median: 7, mean: null, p90: null, observations },
      costPerRoundTripUsd: 0.43,
    });
    expect(result.tripsSaved.observations).toBeNull();
    // A corrupt denominator does not invalidate the distribution beside it.
    expect(result.median).toBeCloseTo(100 * 7 * 0.43, 10);
    expect(() => sessionMeshSavingsValidator.parse(result)).not.toThrow();
  });

  it("returns null rather than Infinity on overflow", () => {
    const result = sessionMeshSavings({
      engagedDeliveries: Number.MAX_SAFE_INTEGER,
      tripsSaved: {
        median: Number.MAX_VALUE,
        mean: null,
        p90: null,
        observations: 1,
      },
      costPerRoundTripUsd: Number.MAX_VALUE,
    });
    expect(result.median).toBeNull();
  });

  it("produces a payload its own validator accepts", () => {
    const result = sessionMeshSavings({
      engagedDeliveries: 42,
      tripsSaved: trips,
      costPerRoundTripUsd: 0.43,
    });
    expect(() => sessionMeshSavingsValidator.parse(result)).not.toThrow();
  });
});

describe("contract", () => {
  it("reports exactly the three operator-directed percentiles", () => {
    expect(Object.values(SessionMeshSavingsPercentile)).toEqual([
      "median",
      "mean",
      "p90",
    ]);
  });

  it("names every percentile the savings payload carries", () => {
    const result = sessionMeshSavings({
      engagedDeliveries: 1,
      tripsSaved: trips,
      costPerRoundTripUsd: 1,
    });
    for (const percentile of Object.values(SessionMeshSavingsPercentile)) {
      expect(result).toHaveProperty(percentile);
      expect(result.tripsSaved).toHaveProperty(percentile);
    }
  });

  it("rejects a negative trips-saved distribution at the boundary", () => {
    expect(() =>
      sessionMeshTripsSavedValidator.parse({
        median: -1,
        mean: 2,
        p90: 3,
        observations: 5,
      })
    ).toThrow();
  });

  it("accepts an entirely unknown distribution without defaulting it to zero", () => {
    const parsed = sessionMeshTripsSavedValidator.parse({
      median: null,
      mean: null,
      p90: null,
      observations: 0,
    });
    expect(parsed.median).toBeNull();
  });
});
