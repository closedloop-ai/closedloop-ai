/**
 * ISS-10731 — the statistics behind the findings/survival join.
 *
 * A JOIN IS NOT A CAUSE, and this module is deliberately the weakest claim that
 * answers the question asked: "does survival rise with reviewer confirmed
 * findings, HOLDING VOLUME CONSTANT?" That is a partial correlation, so both the
 * raw association and the volume-controlled one are published and neither is
 * labelled causal. The confounds that a coefficient cannot address travel with
 * the result rather than in a document
 * (`FINDINGS_SURVIVAL_CONFOUNDS` in ./findings-survival-join.ts).
 *
 * A NULL OR NEGATIVE RESULT IS A RESULT. Every outcome is the same shape with
 * the same fields, so a renderer cannot give a positive one more prominence
 * than a negative one by handling it on a wider branch.
 *
 * UNKNOWN IS NEVER ZERO here either: too few pairs, or an input with no
 * variance, yields `known: false` carrying the pair count — never `r = 0`,
 * which would read as a measured absence of association.
 *
 * A COEFFICIENT IS NOT A VERDICT WITHOUT ITS SAMPLE SIZE. A bare `|r| >= 0.2`
 * cut calls noise a direction: at five agents almost any series clears it, and
 * the report would print "evidence against the two-numerator model" from five
 * points. Every coefficient here therefore carries a Fisher-z confidence
 * interval computed from its own residual degrees of freedom, and the VERDICT
 * is read off that interval, not off `r` alone — a direction needs an interval
 * that excludes zero, and a null needs one that lies wholly inside the
 * threshold. A cohort too small to do either reads Unknown WITH its coefficient
 * still attached: an undecided direction is not a missing number.
 */

/** |r| at or above this is called a direction; below it is called null. */
export const FINDINGS_SURVIVAL_CORRELATION_NULL_THRESHOLD = 0.2;

/** The minimum pairs a RAW coefficient will be computed over. */
export const FINDINGS_SURVIVAL_CORRELATION_MIN_PAIRS = 3;

/**
 * The minimum pairs a coefficient with ONE control will be computed over.
 *
 * Residualising two series against one control costs a degree of freedom, so
 * three pairs leave a single residual dimension: both residual vectors lie on
 * the same line and the partial coefficient is mechanically ±1 whatever the
 * underlying association. Three-agent cohorts therefore have no partial
 * correlation at all, rather than a saturated one that renders as a headline.
 */
export const FINDINGS_SURVIVAL_PARTIAL_CORRELATION_MIN_PAIRS = 4;

/** The confidence every published interval is taken at. */
export const FINDINGS_SURVIVAL_CORRELATION_CONFIDENCE = 0.95;

/** Two-sided normal deviate for {@link FINDINGS_SURVIVAL_CORRELATION_CONFIDENCE}. */
const CONFIDENCE_DEVIATE = 1.959_963_985;

/**
 * Fisher's z is undefined at exactly ±1, which a small perfectly-ordered cohort
 * reaches. Bounding a hair inside publishes the degenerate interval it implies
 * — [±1, ±1] to three places — instead of dropping the result to Unknown and
 * throwing away a coefficient we do have.
 */
const MAX_TRANSFORMABLE_COEFFICIENT = 1 - 1e-9;

export const FindingsSurvivalCorrelationVerdict = {
  Positive: "positive",
  Negative: "negative",
  /** Measured, and the association is bounded below the stated threshold. */
  Null: "null",
  /** Not decidable from this cohort. NOT an association of zero. */
  Unknown: "unknown",
} as const;
export type FindingsSurvivalCorrelationVerdict =
  (typeof FindingsSurvivalCorrelationVerdict)[keyof typeof FindingsSurvivalCorrelationVerdict];

/** The coefficient's interval at {@link FINDINGS_SURVIVAL_CORRELATION_CONFIDENCE}. */
export type FindingsSurvivalCorrelationInterval = {
  low: number;
  high: number;
  confidence: number;
};

export type FindingsSurvivalCorrelation = {
  verdict: FindingsSurvivalCorrelationVerdict;
  /**
   * Absent only when no coefficient could be computed at all. An Unknown
   * verdict may still carry one: a direction this cohort cannot decide is not
   * the same fact as a number we do not have.
   */
  coefficient?: number;
  /** Absent when the residual degrees of freedom cannot support one. */
  interval?: FindingsSurvivalCorrelationInterval;
  /** The population every verdict carries, decidable or not. */
  pairs: number;
  /** How many variables were held constant, which costs a degree of freedom each. */
  controls: number;
  nullThreshold: number;
};

function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

/** Float error can carry a coefficient just past ±1; it has no meaning there. */
function clampCoefficient(coefficient: number): number {
  return Math.min(1, Math.max(-1, coefficient));
}

/**
 * Pearson r, or `undefined` when it is not defined for these inputs — too few
 * pairs, a constant series (zero variance), or a non-finite result.
 */
export function findingsSurvivalPearson(
  xs: readonly number[],
  ys: readonly number[]
): number | undefined {
  if (
    xs.length !== ys.length ||
    xs.length < FINDINGS_SURVIVAL_CORRELATION_MIN_PAIRS
  ) {
    return undefined;
  }
  const xMean = mean(xs);
  const yMean = mean(ys);
  let covariance = 0;
  let xVariance = 0;
  let yVariance = 0;
  for (const [index, x] of xs.entries()) {
    const dx = x - xMean;
    const dy = (ys[index] ?? 0) - yMean;
    covariance += dx * dy;
    xVariance += dx * dx;
    yVariance += dy * dy;
  }
  if (xVariance === 0 || yVariance === 0) {
    return undefined;
  }
  const coefficient = covariance / Math.sqrt(xVariance * yVariance);
  return Number.isFinite(coefficient)
    ? clampCoefficient(coefficient)
    : undefined;
}

/**
 * The association between `xs` and `ys` with `controls` held constant.
 *
 * This is the ticket's actual question. Stickiness is a ratio, so an agent that
 * wrote almost nothing can post a high one; without holding volume constant the
 * comparison rewards whoever wrote least, which is the second confound the
 * ticket names.
 *
 * Refuses below {@link FINDINGS_SURVIVAL_PARTIAL_CORRELATION_MIN_PAIRS}: the
 * raw floor is one pair short of what one control needs.
 */
export function findingsSurvivalPartialPearson(
  xs: readonly number[],
  ys: readonly number[],
  controls: readonly number[]
): number | undefined {
  if (xs.length < FINDINGS_SURVIVAL_PARTIAL_CORRELATION_MIN_PAIRS) {
    return undefined;
  }
  const xy = findingsSurvivalPearson(xs, ys);
  const xc = findingsSurvivalPearson(xs, controls);
  const yc = findingsSurvivalPearson(ys, controls);
  if (xy === undefined || xc === undefined || yc === undefined) {
    return undefined;
  }
  const denominator = Math.sqrt((1 - xc * xc) * (1 - yc * yc));
  if (denominator === 0) {
    return undefined;
  }
  const coefficient = (xy - xc * yc) / denominator;
  return Number.isFinite(coefficient)
    ? clampCoefficient(coefficient)
    : undefined;
}

/**
 * The coefficient's confidence interval, or `undefined` when the cohort has no
 * residual degrees of freedom left to estimate one with.
 */
export function findingsSurvivalCorrelationInterval(
  coefficient: number,
  pairs: number,
  controls: number
): FindingsSurvivalCorrelationInterval | undefined {
  const degreesOfFreedom = pairs - 3 - controls;
  if (degreesOfFreedom <= 0) {
    return undefined;
  }
  const bounded = Math.min(
    Math.max(coefficient, -MAX_TRANSFORMABLE_COEFFICIENT),
    MAX_TRANSFORMABLE_COEFFICIENT
  );
  const centre = Math.atanh(bounded);
  const margin = CONFIDENCE_DEVIATE / Math.sqrt(degreesOfFreedom);
  return {
    low: clampCoefficient(Math.tanh(centre - margin)),
    high: clampCoefficient(Math.tanh(centre + margin)),
    confidence: FINDINGS_SURVIVAL_CORRELATION_CONFIDENCE,
  };
}

/**
 * Which verdict an interval supports.
 *
 * A direction needs an interval that excludes zero AND a coefficient past the
 * threshold; a null needs the whole interval inside the threshold, which is the
 * only shape that is evidence the association is small rather than merely
 * unmeasured. Anything else is a cohort that cannot decide.
 */
function verdictFor(
  coefficient: number,
  interval: FindingsSurvivalCorrelationInterval | undefined
): FindingsSurvivalCorrelationVerdict {
  const threshold = FINDINGS_SURVIVAL_CORRELATION_NULL_THRESHOLD;
  if (interval === undefined) {
    return FindingsSurvivalCorrelationVerdict.Unknown;
  }
  if (interval.low > 0 && coefficient >= threshold) {
    return FindingsSurvivalCorrelationVerdict.Positive;
  }
  if (interval.high < 0 && coefficient <= -threshold) {
    return FindingsSurvivalCorrelationVerdict.Negative;
  }
  if (interval.low >= -threshold && interval.high <= threshold) {
    return FindingsSurvivalCorrelationVerdict.Null;
  }
  return FindingsSurvivalCorrelationVerdict.Unknown;
}

/** Wrap a coefficient — or its absence — as a verdict carrying its population. */
export function findingsSurvivalCorrelation(
  coefficient: number | undefined,
  pairs: number,
  controls = 0
): FindingsSurvivalCorrelation {
  const base = {
    pairs,
    controls,
    nullThreshold: FINDINGS_SURVIVAL_CORRELATION_NULL_THRESHOLD,
  };
  if (coefficient === undefined) {
    return { verdict: FindingsSurvivalCorrelationVerdict.Unknown, ...base };
  }
  const interval = findingsSurvivalCorrelationInterval(
    coefficient,
    pairs,
    controls
  );
  return {
    verdict: verdictFor(coefficient, interval),
    coefficient,
    interval,
    ...base,
  };
}
