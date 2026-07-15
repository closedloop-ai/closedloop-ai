import { describe, expect, it } from "vitest";
import { makeBranch, makePr, makeSession } from "./fixtures.test-helpers.ts";
import { branchMeasures, prMeasures, sessionMeasures } from "./measures.ts";

describe("prMeasures", () => {
  it("linesGross = additions + deletions", () => {
    expect(prMeasures.linesGross(makePr({ additions: 10, deletions: 5 }))).toBe(
      15
    );
  });

  it("linesGross treats nulls as 0", () => {
    expect(
      prMeasures.linesGross(makePr({ additions: null, deletions: null }))
    ).toBe(0);
  });

  it("linesNet = additions − deletions", () => {
    expect(prMeasures.linesNet(makePr({ additions: 10, deletions: 5 }))).toBe(
      5
    );
  });

  it("mergeLatencyMs = mergedAt − createdAt", () => {
    expect(
      prMeasures.mergeLatencyMs(makePr({ createdAt: 100, mergedAt: 350 }))
    ).toBe(250);
  });

  it("mergeLatencyMs is null for unmerged PRs", () => {
    expect(prMeasures.mergeLatencyMs(makePr({ mergedAt: null }))).toBeNull();
  });

  it("mergeLatencyMs is null when a clock-skewed PR merges before creation", () => {
    // A negative interval would otherwise flow straight into the TimeToMerge
    // median (the pipeline drops only nulls, not negatives) — see the compute
    // test asserting the negative is excluded from the median.
    expect(
      prMeasures.mergeLatencyMs(makePr({ createdAt: 350, mergedAt: 100 }))
    ).toBeNull();
  });

  it("one is always 1", () => {
    expect(prMeasures.one()).toBe(1);
  });
});

describe("sessionMeasures", () => {
  it("cost returns costUsd, null when absent", () => {
    expect(sessionMeasures.cost(makeSession({ costUsd: 2.5 }))).toBe(2.5);
    expect(sessionMeasures.cost(makeSession({ costUsd: null }))).toBeNull();
  });

  it("tokens returns tokens, null when absent", () => {
    expect(sessionMeasures.tokens(makeSession({ tokens: 42 }))).toBe(42);
    expect(sessionMeasures.tokens(makeSession({ tokens: null }))).toBeNull();
  });
});

describe("branchMeasures", () => {
  it("branchLinesGross = additions + deletions, nulls as 0", () => {
    expect(
      branchMeasures.branchLinesGross(
        makeBranch({ additions: 100, deletions: 50 })
      )
    ).toBe(150);
    expect(
      branchMeasures.branchLinesGross(
        makeBranch({ additions: null, deletions: null })
      )
    ).toBe(0);
  });
});
