/**
 * Pure score statistics for judges-analytics. Nothing here reads the database:
 * every function is a total function of its arguments, which is what lets the
 * judge-radar suite pin exact numeric behavior without a DB mock.
 */
import { JUDGE_RADAR_METRICS, JUDGE_THRESHOLDS } from "@repo/api/src/constants";
import type {
  CharacteristicLabel,
  RadarAxes,
} from "@repo/api/src/types/judges-analytics";
import {
  clamp,
  computeMean as computeMeanFromUtils,
} from "@repo/api/src/utils/math";

export function computeMean(values: number[]): number {
  return computeMeanFromUtils(values);
}

export function computeStdDev(values: number[], mean: number): number {
  if (values.length === 0) {
    return 0;
  }
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function computeSkewness(
  values: number[],
  mean: number,
  stdDev: number
): number {
  const n = values.length;
  if (n < 3 || stdDev === 0) {
    return 0;
  }
  const m3 = values.reduce((acc, v) => acc + ((v - mean) / stdDev) ** 3, 0) / n;
  return m3;
}

export function computeExcessKurtosis(
  values: number[],
  mean: number,
  stdDev: number
): number {
  const n = values.length;
  if (n < 4 || stdDev === 0) {
    return 0;
  }
  const m4 = values.reduce((acc, v) => acc + ((v - mean) / stdDev) ** 4, 0) / n;
  return m4 - 3;
}

export function computeBimodalityCoefficient(values: number[]): number {
  const n = values.length;
  if (n < 4) {
    return 0;
  }

  const mean = computeMean(values);
  const stdDev = computeStdDev(values, mean);
  if (stdDev === 0) {
    return 0;
  }

  const skewness = computeSkewness(values, mean, stdDev);
  const excessKurtosis = computeExcessKurtosis(values, mean, stdDev);

  const denominator = excessKurtosis + (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  if (denominator <= 0) {
    return 0;
  }

  const bc = (skewness ** 2 + 1) / denominator;
  return clamp(bc, 0, 1);
}

export function computeCertaintyFraction(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const extremeCount = values.filter(
    (v) =>
      v > JUDGE_RADAR_METRICS.certainty.extremeHighScore ||
      v < JUDGE_RADAR_METRICS.certainty.extremeLowScore
  ).length;
  return extremeCount / values.length;
}

// ---------------------------------------------------------------------------
// Power-sum moment reconstruction
//
// These derive the exact same mean / stdDev / skewness / excess-kurtosis /
// bimodality / certainty values as the array-based helpers above, but from
// DB-computed power sums — so a caller never has to materialize the full score
// population. Central moments are recovered from raw power sums via the
// standard binomial expansions:
//   m2 = Σx²/n − μ²
//   m3 = Σx³/n − 3μ·Σx²/n + 2μ³
//   m4 = Σx⁴/n − 4μ·Σx³/n + 6μ²·Σx²/n − 3μ⁴
// Skewness = m3/σ³ and excess kurtosis = m4/σ⁴ − 3 (population, matching the
// array implementations). The `n<3` / `n<4` / `σ===0` guards are replicated so
// the outputs stay bit-for-bit identical to the prior in-app computation.
// ---------------------------------------------------------------------------

/**
 * Population standard deviation derived from power sums.
 *
 * Algebraically equal to {@link computeStdDev} (`sqrt(mean((v-mean)^2))`) via
 * `variance = E[x^2] - E[x]^2`. The `Math.max(0, …)` guards against a tiny
 * negative variance from floating-point cancellation.
 */
export function stdDevFromPowerSums(
  count: number,
  sum: number,
  sumSq: number
): number {
  if (count === 0) {
    return 0;
  }
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  return Math.sqrt(variance);
}

/** Raw power sums (+ extreme count) over one score population. */
export type ScorePowerMoments = {
  count: number;
  sum: number;
  sumSq: number;
  sum3: number;
  sum4: number;
  extremeCount: number;
};

export const EMPTY_POWER_MOMENTS: ScorePowerMoments = {
  count: 0,
  sum: 0,
  sumSq: 0,
  sum3: 0,
  sum4: 0,
  extremeCount: 0,
};

/** Combine two power-sum accumulators (used to roll per-version → overall). */
export function addPowerMoments(
  a: ScorePowerMoments,
  b: ScorePowerMoments
): ScorePowerMoments {
  return {
    count: a.count + b.count,
    sum: a.sum + b.sum,
    sumSq: a.sumSq + b.sumSq,
    sum3: a.sum3 + b.sum3,
    sum4: a.sum4 + b.sum4,
    extremeCount: a.extremeCount + b.extremeCount,
  };
}

export function meanFromMoments(m: ScorePowerMoments): number {
  return m.count === 0 ? 0 : m.sum / m.count;
}

export function stdDevFromMoments(m: ScorePowerMoments): number {
  return stdDevFromPowerSums(m.count, m.sum, m.sumSq);
}

function skewnessFromMoments(m: ScorePowerMoments, stdDev: number): number {
  const n = m.count;
  if (n < 3 || stdDev === 0) {
    return 0;
  }
  const mean = m.sum / n;
  const m3 = m.sum3 / n - (3 * mean * m.sumSq) / n + 2 * mean ** 3;
  return m3 / stdDev ** 3;
}

function excessKurtosisFromMoments(
  m: ScorePowerMoments,
  stdDev: number
): number {
  const n = m.count;
  if (n < 4 || stdDev === 0) {
    return 0;
  }
  const mean = m.sum / n;
  const m4 =
    m.sum4 / n -
    (4 * mean * m.sum3) / n +
    (6 * mean ** 2 * m.sumSq) / n -
    3 * mean ** 4;
  return m4 / stdDev ** 4 - 3;
}

export function bimodalityFromMoments(m: ScorePowerMoments): number {
  const n = m.count;
  if (n < 4) {
    return 0;
  }
  const stdDev = stdDevFromMoments(m);
  if (stdDev === 0) {
    return 0;
  }
  const skewness = skewnessFromMoments(m, stdDev);
  const excessKurtosis = excessKurtosisFromMoments(m, stdDev);
  const denominator = excessKurtosis + (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  if (denominator <= 0) {
    return 0;
  }
  const bc = (skewness ** 2 + 1) / denominator;
  return clamp(bc, 0, 1);
}

export function certaintyFractionFromMoments(m: ScorePowerMoments): number {
  return m.count === 0 ? 0 : m.extremeCount / m.count;
}

export function toRadarAxes(
  stdDev: number,
  mean: number,
  bimodality: number,
  certaintyFraction: number
): RadarAxes {
  return {
    stubbornness:
      1 -
      clamp(
        stdDev / JUDGE_RADAR_METRICS.stubbornness.stdDevNormalizationDivisor,
        0,
        1
      ),
    optimism: mean,
    polarity: bimodality,
    certainty: certaintyFraction,
  };
}

export function deriveCharacteristicLabels(
  stdDev: number,
  mean: number,
  bimodality: number,
  certaintyFraction: number
): CharacteristicLabel[] {
  const labels: CharacteristicLabel[] = [];

  if (stdDev < JUDGE_THRESHOLDS.stubbornness.stubborn) {
    labels.push("Stubborn");
  } else if (stdDev > JUDGE_THRESHOLDS.stubbornness.openMinded) {
    labels.push("Open-Minded");
  }

  if (mean > JUDGE_THRESHOLDS.optimism.optimistic) {
    labels.push("Optimistic");
  } else if (mean < JUDGE_THRESHOLDS.optimism.critical) {
    labels.push("Critical");
  }

  if (bimodality > JUDGE_THRESHOLDS.polarity.polarizing) {
    labels.push("Polarizing");
  }

  if (certaintyFraction > JUDGE_THRESHOLDS.certainty.decisive) {
    labels.push("Decisive");
  } else if (certaintyFraction < JUDGE_THRESHOLDS.certainty.uncertain) {
    labels.push("Uncertain");
  }

  return labels;
}
