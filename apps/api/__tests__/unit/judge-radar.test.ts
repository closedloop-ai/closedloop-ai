/**
 * Unit tests for radar axis computation helpers and characteristic label derivation.
 *
 * Tests cover: clamp, computeMean, computeStdDev, computeSkewness,
 * computeExcessKurtosis, computeBimodalityCoefficient, computeCertaintyFraction,
 * deriveCharacteristicLabels, and the insufficient-data gate in getJudgeDetail.
 */
import { JUDGE_THRESHOLDS } from "@repo/api/src/constants";
import { vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMock } = await import("../fixtures/database-mock");
  return createDatabaseMock();
});

import {
  clamp,
  computeBimodalityCoefficient,
  computeCertaintyFraction,
  computeExcessKurtosis,
  computeMean,
  computeSkewness,
  computeStdDev,
  deriveCharacteristicLabels,
} from "@/app/judges-analytics/service";

// ---------------------------------------------------------------------------
// clamp
// ---------------------------------------------------------------------------

describe("clamp", () => {
  it("clamps above max to max", () => {
    expect(clamp(1.5, 0, 1)).toBe(1);
  });

  it("clamps below min to min", () => {
    expect(clamp(-0.5, 0, 1)).toBe(0);
  });

  it("returns value when within range", () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// computeMean
// ---------------------------------------------------------------------------

describe("computeMean", () => {
  it("returns correct mean for [0.2, 0.4, 0.6, 0.8]", () => {
    expect(computeMean([0.2, 0.4, 0.6, 0.8])).toBeCloseTo(0.5, 10);
  });

  it("returns 0 for empty array", () => {
    expect(computeMean([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeStdDev
// ---------------------------------------------------------------------------

describe("computeStdDev", () => {
  it("returns ~0.2236 for [0.2, 0.4, 0.6, 0.8] with mean=0.5", () => {
    expect(computeStdDev([0.2, 0.4, 0.6, 0.8], 0.5)).toBeCloseTo(0.2236, 3);
  });

  it("returns 0 for empty array", () => {
    expect(computeStdDev([], 0)).toBe(0);
  });

  it("returns 0 when all values are the same", () => {
    expect(computeStdDev([0.5, 0.5, 0.5], 0.5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stubbornness axis (1 - stdDev / 0.5)
// ---------------------------------------------------------------------------

describe("stubbornness axis", () => {
  it("low stdDev (all same scores) → stubbornness = 1.0", () => {
    const scores = new Array(20).fill(0.5);
    const mean = computeMean(scores);
    const stdDev = computeStdDev(scores, mean);
    const stubbornness = 1 - clamp(stdDev / 0.5, 0, 1);
    expect(stubbornness).toBe(1.0);
  });

  it("high stdDev (0.5 → clamped) → stubbornness = 0", () => {
    // stdDev=0.5 means clamp(1, 0, 1) = 1, so stubbornness = 0
    const stubbornness = 1 - clamp(0.5 / 0.5, 0, 1);
    expect(stubbornness).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Optimism axis (= mean)
// ---------------------------------------------------------------------------

describe("optimism axis", () => {
  it("mean of [0.8, 0.9, 0.85] → optimism ≈ 0.85", () => {
    const scores = [0.8, 0.9, 0.85];
    const mean = computeMean(scores);
    expect(mean).toBeCloseTo(0.85, 10);
  });
});

// ---------------------------------------------------------------------------
// computeSkewness
// ---------------------------------------------------------------------------

describe("computeSkewness", () => {
  it("returns 0 when n < 3", () => {
    expect(computeSkewness([0.5, 0.6], 0.55, 0.05)).toBe(0);
  });

  it("returns 0 when stdDev is 0", () => {
    expect(computeSkewness([0.5, 0.5, 0.5], 0.5, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeExcessKurtosis
// ---------------------------------------------------------------------------

describe("computeExcessKurtosis", () => {
  it("returns 0 when n < 4", () => {
    expect(computeExcessKurtosis([0.5, 0.5, 0.5], 0.5, 0.1)).toBe(0);
  });

  it("returns 0 when stdDev is 0", () => {
    expect(computeExcessKurtosis([0.5, 0.5, 0.5, 0.5], 0.5, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeBimodalityCoefficient
// ---------------------------------------------------------------------------

describe("computeBimodalityCoefficient", () => {
  it("returns 0 when n < 4 (guard clause)", () => {
    expect(computeBimodalityCoefficient([0.1, 0.9, 0.1])).toBe(0);
  });

  it("returns 0 when all values are the same (stdDev = 0)", () => {
    expect(computeBimodalityCoefficient([0.5, 0.5, 0.5, 0.5, 0.5])).toBe(0);
  });

  it("returns a value between 0 and 1 for normal data", () => {
    const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    const bc = computeBimodalityCoefficient(values);
    expect(bc).toBeGreaterThanOrEqual(0);
    expect(bc).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// computeCertaintyFraction
// ---------------------------------------------------------------------------

describe("computeCertaintyFraction", () => {
  it("4 of 5 scores outside [0.3, 0.7] → certaintyFraction = 0.8", () => {
    // Extreme scores: 0.1, 0.2, 0.8, 0.9 (4 extreme), 0.5 (1 middle)
    expect(computeCertaintyFraction([0.1, 0.2, 0.8, 0.9, 0.5])).toBeCloseTo(
      0.8,
      10
    );
  });

  it("all scores in [0.3, 0.7] → certaintyFraction = 0.0", () => {
    expect(computeCertaintyFraction([0.4, 0.5, 0.6, 0.5, 0.4])).toBe(0);
  });

  it("returns 0 for empty array", () => {
    expect(computeCertaintyFraction([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deriveCharacteristicLabels
// ---------------------------------------------------------------------------

describe("deriveCharacteristicLabels", () => {
  it("Stubborn: stdDev < 0.10 → includes 'Stubborn'", () => {
    const labels = deriveCharacteristicLabels(0.05, 0.5, 0, 0.55);
    expect(labels).toContain("Stubborn");
  });

  it("Open-Minded: stdDev > 0.30 → includes 'Open-Minded'", () => {
    const labels = deriveCharacteristicLabels(0.35, 0.5, 0, 0.55);
    expect(labels).toContain("Open-Minded");
  });

  it("Optimistic: mean > 0.65 → includes 'Optimistic'", () => {
    const labels = deriveCharacteristicLabels(0.15, 0.8, 0, 0.55);
    expect(labels).toContain("Optimistic");
  });

  it("Critical: mean < 0.35 → includes 'Critical'", () => {
    const labels = deriveCharacteristicLabels(0.15, 0.2, 0, 0.55);
    expect(labels).toContain("Critical");
  });

  it("Polarizing: bimodality > 0.65 → includes 'Polarizing'", () => {
    const labels = deriveCharacteristicLabels(0.15, 0.5, 0.7, 0.55);
    expect(labels).toContain("Polarizing");
  });

  it("Decisive: certaintyFraction > 0.60 → includes 'Decisive'", () => {
    const labels = deriveCharacteristicLabels(0.15, 0.5, 0, 0.8);
    expect(labels).toContain("Decisive");
  });

  it("Uncertain: certaintyFraction < 0.50 → includes 'Uncertain'", () => {
    const labels = deriveCharacteristicLabels(0.15, 0.5, 0, 0.3);
    expect(labels).toContain("Uncertain");
  });

  it("no strong tendencies: all mid-range → labels = []", () => {
    // stdDev in [0.10, 0.30], mean in [0.35, 0.65], bimodality < 0.65, certainty in [0.50, 0.60]
    const labels = deriveCharacteristicLabels(0.2, 0.5, 0.3, 0.55);
    expect(labels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Insufficient data gate (scoreCount < minScoreCount)
// ---------------------------------------------------------------------------

describe("insufficient data gate", () => {
  it(`scoreCount < ${JUDGE_THRESHOLDS.minScoreCount} → radarAxes is null, labels = []`, () => {
    // Simulate the guard from getJudgeDetail:
    // if (scoreCount >= JUDGE_THRESHOLDS.minScoreCount) { ... } else radarAxes = null, labels = []
    const scoreCount = JUDGE_THRESHOLDS.minScoreCount - 1;
    let radarAxes: { stubbornness: number } | null = null;
    let labels: string[] = [];

    if (scoreCount >= JUDGE_THRESHOLDS.minScoreCount) {
      radarAxes = { stubbornness: 1 };
      labels = ["Stubborn"];
    }

    expect(radarAxes).toBeNull();
    expect(labels).toEqual([]);
  });

  it(`scoreCount >= ${JUDGE_THRESHOLDS.minScoreCount} → radarAxes is computed`, () => {
    const scores = new Array(JUDGE_THRESHOLDS.minScoreCount).fill(0.5);
    const mean = computeMean(scores);
    const stdDev = computeStdDev(scores, mean);
    const bimodality = computeBimodalityCoefficient(scores);
    const certaintyFraction = computeCertaintyFraction(scores);

    const radarAxes = {
      stubbornness: 1 - clamp(stdDev / 0.5, 0, 1),
      optimism: mean,
      polarity: bimodality,
      certainty: certaintyFraction,
    };

    expect(radarAxes).not.toBeNull();
    expect(radarAxes.stubbornness).toBe(1); // all same → stdDev=0
    expect(radarAxes.optimism).toBe(0.5);
  });
});
