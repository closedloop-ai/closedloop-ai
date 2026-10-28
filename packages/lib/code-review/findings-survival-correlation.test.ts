import { describe, expect, it } from "vitest";
import {
  FINDINGS_SURVIVAL_CORRELATION_MIN_PAIRS,
  FINDINGS_SURVIVAL_CORRELATION_NULL_THRESHOLD,
  FINDINGS_SURVIVAL_PARTIAL_CORRELATION_MIN_PAIRS,
  FindingsSurvivalCorrelationVerdict,
  findingsSurvivalCorrelation,
  findingsSurvivalPartialPearson,
  findingsSurvivalPearson,
} from "./findings-survival-correlation.ts";

/** Enough pairs that the interval is narrower than the threshold it is tested against. */
const AMPLE_PAIRS = 1000;

describe("findingsSurvivalPearson", () => {
  it("measures a perfect association in each direction", () => {
    expect(findingsSurvivalPearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(findingsSurvivalPearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1);
  });

  it("has no coefficient below the stated minimum pair count", () => {
    // Literal 3, not the constant: lowering the floor must redden here.
    expect(FINDINGS_SURVIVAL_CORRELATION_MIN_PAIRS).toBe(3);
    expect(findingsSurvivalPearson([1, 2], [2, 4])).toBeUndefined();
    expect(findingsSurvivalPearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });

  it("has no coefficient for a constant series or a length mismatch", () => {
    expect(findingsSurvivalPearson([2, 2, 2, 2], [1, 2, 3, 4])).toBeUndefined();
    expect(findingsSurvivalPearson([1, 2, 3, 4], [5, 5, 5, 5])).toBeUndefined();
    expect(findingsSurvivalPearson([1, 2, 3], [1, 2])).toBeUndefined();
  });
});

describe("findingsSurvivalPartialPearson", () => {
  it("refuses three pairs, where one control saturates the residuals", () => {
    // Removing one control from three observations leaves a single residual
    // dimension, so both residual vectors lie on the same line and the partial
    // is mechanically +/-1 whatever the data says. The raw floor of 3 is one
    // pair short here, so this carries its own. Literals, so lowering either
    // constant reddens this case.
    expect(FINDINGS_SURVIVAL_PARTIAL_CORRELATION_MIN_PAIRS).toBe(4);
    expect(FINDINGS_SURVIVAL_CORRELATION_MIN_PAIRS).toBe(3);
    expect(
      findingsSurvivalPartialPearson([1, 5, 2], [7, 3, 9], [4, 2, 8])
    ).toBeUndefined();
    const atFour = findingsSurvivalPartialPearson(
      [1, 5, 2, 6],
      [7, 3, 9, 2],
      [4, 2, 8, 5]
    );
    expect(atFour).toBeDefined();
    // Four pairs leave two residual dimensions, so the answer is a real one
    // rather than the saturated +/-1 three pairs always produce.
    expect(Math.abs(atFour ?? 1)).toBeLessThan(1);
  });

  it("never reports a coefficient outside [-1, 1]", () => {
    // A near-saturated cohort takes the quotient past -1 by float error alone,
    // and -1.0000000000005587 would render as a coefficient no correlation can
    // have.
    const coefficient = findingsSurvivalPartialPearson(
      [16, 0, 16, 11],
      [13, 0, 13, 19],
      [5, 16, 5, 0]
    );
    expect(coefficient).toBe(-1);
  });

  it("removes an association that the control fully explains", () => {
    const findings = [1, 2, 3, 4, 5];
    const survival = [10, 20, 30, 40, 50];
    // The control tracks findings exactly, so nothing is left to vary.
    expect(
      findingsSurvivalPartialPearson(findings, survival, findings)
    ).toBeUndefined();
  });

  it("has no coefficient when only ONE side is collinear with the control", () => {
    const findings = [1, 2, 3, 4, 5];
    const survival = [3, 1, 4, 1, 6];
    expect(
      findingsSurvivalPartialPearson(findings, survival, findings)
    ).toBeUndefined();
    expect(
      findingsSurvivalPartialPearson(survival, findings, findings)
    ).toBeUndefined();
  });

  it("keeps an association the control does not explain", () => {
    const findings = [1, 2, 3, 4, 5];
    const survival = [2, 4, 6, 8, 10];
    const volume = [5, 1, 4, 2, 3];
    const partial = findingsSurvivalPartialPearson(findings, survival, volume);
    expect(partial).toBeDefined();
    expect(partial).toBeGreaterThan(0.9);
  });
});

describe("findingsSurvivalCorrelation", () => {
  it("calls a coefficient AT the threshold a direction, not a null", () => {
    // The boundary is inclusive in both directions. Literal 0.2, so a change to
    // the threshold or to `>=`/`<=` reddens here.
    expect(FINDINGS_SURVIVAL_CORRELATION_NULL_THRESHOLD).toBe(0.2);
    expect(findingsSurvivalCorrelation(0.2, AMPLE_PAIRS).verdict).toBe(
      FindingsSurvivalCorrelationVerdict.Positive
    );
    expect(findingsSurvivalCorrelation(-0.2, AMPLE_PAIRS).verdict).toBe(
      FindingsSurvivalCorrelationVerdict.Negative
    );
    expect(findingsSurvivalCorrelation(0.199, AMPLE_PAIRS).verdict).not.toBe(
      FindingsSurvivalCorrelationVerdict.Positive
    );
    expect(findingsSurvivalCorrelation(-0.199, AMPLE_PAIRS).verdict).not.toBe(
      FindingsSurvivalCorrelationVerdict.Negative
    );
  });

  it("calls a null only when the whole interval sits inside the threshold", () => {
    const measured = findingsSurvivalCorrelation(0.05, AMPLE_PAIRS);
    expect(measured.verdict).toBe(FindingsSurvivalCorrelationVerdict.Null);
    expect(measured.interval?.low).toBeGreaterThan(
      -FINDINGS_SURVIVAL_CORRELATION_NULL_THRESHOLD
    );
    expect(measured.interval?.high).toBeLessThan(
      FINDINGS_SURVIVAL_CORRELATION_NULL_THRESHOLD
    );
  });

  it("refuses to call a small cohort a direction OR a null", () => {
    // Five agents holding one control: the interval spans nearly the whole
    // range, so r = 0.6 is not a direction and r = 0 is not a null. Reading
    // either off |r| alone is how noise gets printed as a finding.
    const direction = findingsSurvivalCorrelation(0.6, 5, 1);
    expect(direction.verdict).toBe(FindingsSurvivalCorrelationVerdict.Unknown);
    // Unknown carries the coefficient it could not decide: an undecided
    // direction is not a missing number.
    expect(direction.coefficient).toBe(0.6);
    expect(direction.interval?.low).toBeLessThan(0);
    expect(findingsSurvivalCorrelation(0, 5, 1).verdict).toBe(
      FindingsSurvivalCorrelationVerdict.Unknown
    );
  });

  it("has no interval when the controls leave no degrees of freedom", () => {
    const saturated = findingsSurvivalCorrelation(0.99, 4, 1);
    expect(saturated.interval).toBeUndefined();
    expect(saturated.verdict).toBe(FindingsSurvivalCorrelationVerdict.Unknown);
    expect(saturated.coefficient).toBe(0.99);
    expect(saturated.controls).toBe(1);
  });

  it("still decides a perfect coefficient, which has no Fisher transform", () => {
    const perfect = findingsSurvivalCorrelation(1, 5, 1);
    expect(perfect.verdict).toBe(FindingsSurvivalCorrelationVerdict.Positive);
    expect(perfect.interval?.low).toBeGreaterThan(0);
  });

  it("reports unknown with its population, never a zero coefficient", () => {
    const unknown = findingsSurvivalCorrelation(undefined, 2);
    expect(unknown.verdict).toBe(FindingsSurvivalCorrelationVerdict.Unknown);
    expect(unknown.coefficient).toBeUndefined();
    expect(unknown.interval).toBeUndefined();
    expect(unknown.pairs).toBe(2);
    expect(unknown.nullThreshold).toBe(0.2);
  });

  it("carries the population and threshold on every verdict alike", () => {
    for (const coefficient of [0.9, -0.9, 0, undefined]) {
      const result = findingsSurvivalCorrelation(coefficient, 7);
      expect(result.pairs).toBe(7);
      expect(result.nullThreshold).toBe(0.2);
    }
  });
});
