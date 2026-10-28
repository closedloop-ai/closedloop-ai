/**
 * ISS-9853 — the Success-rate tile's two coverage claims.
 *
 * `pack-detail.success-rate-readout.test.tsx` drives the real render behind the
 * flag; this pins the readout itself across both coverage axes, including the
 * states a version-skewed producer can reach.
 */
import { describe, expect, it } from "vitest";
import type { PackPerformance } from "../pack-view";
import { successRateTileReadout } from "../success-rate-readout";

const SHIPPED_DELTA_LABEL = "vs. baseline";
const SHIPPED_HEADLINE =
  "Share of the pack's sessions that link to a merged PR.";

function coverage(
  over: Partial<
    Pick<PackPerformance, "baselineSampleSize" | "mergedPrsTruncated">
  > = {}
): Pick<PackPerformance, "baselineSampleSize" | "mergedPrsTruncated"> {
  return { baselineSampleSize: null, mergedPrsTruncated: false, ...over };
}

describe("successRateTileReadout — the comparator's coverage", () => {
  it("names the sample the delta was taken against when one was declared", () => {
    const readout = successRateTileReadout(
      coverage({ baselineSampleSize: 500 })
    );

    expect(readout.deltaLabel).toBe("vs. last 500 baseline sessions");
    expect(readout.info.how).toContain("500 most recent");
  });

  it("keeps the shipped caption when the comparator covered the window", () => {
    const readout = successRateTileReadout(
      coverage({ baselineSampleSize: null })
    );

    expect(readout.deltaLabel).toBe(SHIPPED_DELTA_LABEL);
    expect(readout.info.how).toBeUndefined();
  });

  it("keeps the shipped caption when the producer declared no coverage", () => {
    const undeclared = coverage();
    Reflect.deleteProperty(undeclared, "baselineSampleSize");

    // An omitted field is not evidence of a sample; inventing a caveat here
    // would be the same overstatement pointed the other way.
    expect(successRateTileReadout(undeclared).deltaLabel).toBe(
      SHIPPED_DELTA_LABEL
    );
  });

  it.each([
    ["a fractional count", 12.5],
    ["a zero count", 0],
    ["a negative count", -3],
    ["a non-finite count", Number.NaN],
  ])("renders %s as no declaration at all", (_label, baselineSampleSize) => {
    // Wire data that cannot be a sample size. "Sampled from 12.5 sessions" is
    // worse than saying nothing, so it degrades exactly like an omission.
    const readout = successRateTileReadout(coverage({ baselineSampleSize }));

    expect(readout.deltaLabel).toBe(SHIPPED_DELTA_LABEL);
    expect(readout.info.how).toBeUndefined();
  });
});

describe("successRateTileReadout — the cohort's coverage", () => {
  it("narrows the headline when the value came from a sampled cohort", () => {
    const readout = successRateTileReadout(
      coverage({ mergedPrsTruncated: true })
    );

    expect(readout.info.what).toBe(
      "Share of a sample of the pack's sessions that link to a merged PR."
    );
    // A SHARE moves either way as the uncounted sessions arrive, so the caveat
    // must not borrow the Merged-PRs floor claim.
    expect(readout.info.how).toContain("higher or lower");
    expect(readout.info.how).not.toContain("may be higher.");
  });

  it("keeps the whole-population headline when the cohort was complete", () => {
    const readout = successRateTileReadout(
      coverage({ mergedPrsTruncated: false })
    );

    expect(readout.info.what).toBe(SHIPPED_HEADLINE);
    expect(readout.info.how).toBeUndefined();
  });

  it("withdraws the population claim when the cohort's coverage is undeclared", () => {
    const undeclared = coverage();
    Reflect.deleteProperty(undeclared, "mergedPrsTruncated");

    const readout = successRateTileReadout(undeclared);

    // The headline stays — an omission is not evidence of a sample — but the
    // claim does not stand unqualified: the Merged PRs tile beside it, reading
    // the SAME field, already says it cannot vouch for the population.
    expect(readout.info.what).toBe(SHIPPED_HEADLINE);
    expect(readout.info.how).toContain("does not say whether");
  });

  it("carries both caveats when both populations were sampled", () => {
    const readout = successRateTileReadout(
      coverage({ baselineSampleSize: 500, mergedPrsTruncated: true })
    );

    // The value and the delta are sampled INDEPENDENTLY; disclosing one and
    // dropping the other leaves half the tile claiming a population.
    expect(readout.info.how).toContain("a single bounded read");
    expect(readout.info.how).toContain("500 most recent");
    expect(readout.deltaLabel).toBe("vs. last 500 baseline sessions");
  });
});
