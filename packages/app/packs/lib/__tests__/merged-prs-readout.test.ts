/**
 * @file merged-prs-readout.test.ts
 * @description ISS-6462 — the Packs "Merged PRs" tile presented a capped cohort
 * scan as an exact count. These pin the three coverage states the payload can
 * express, and specifically that an OMITTED `mergedPrsTruncated` is read as
 * unknown rather than folded to "not truncated" (the version-skew case that
 * would silently restore the full-cohort claim).
 */
import { COHORT_SCAN_CAP } from "@repo/api/src/types/analytics";
import { describe, expect, it } from "vitest";
import { mergedPrsTileInfo, mergedPrsTileValue } from "../merged-prs-readout";
import type { PackPerformance } from "../pack-view";

/** A count large enough that the thousands separator is part of the contract. */
const MERGED_PRS_FLOOR = 996;
const MERGED_PRS_BARE = "996";
const MERGED_PRS_FLOOR_MARKED = "996+";

function perf(
  over: Partial<Pick<PackPerformance, "mergedPrs" | "mergedPrsTruncated">> = {}
): Pick<PackPerformance, "mergedPrs" | "mergedPrsTruncated"> {
  return { mergedPrs: MERGED_PRS_FLOOR, mergedPrsTruncated: false, ...over };
}

describe("mergedPrsTileValue (ISS-6462)", () => {
  it("marks a declared-capped count as a floor", () => {
    expect(mergedPrsTileValue(perf({ mergedPrsTruncated: true }))).toBe(
      MERGED_PRS_FLOOR_MARKED
    );
  });

  it("prints a declared whole-cohort count bare", () => {
    expect(mergedPrsTileValue(perf({ mergedPrsTruncated: false }))).toBe(
      MERGED_PRS_BARE
    );
  });

  it("does not invent a floor marker when coverage was never declared", () => {
    const undeclared = perf();
    Reflect.deleteProperty(undeclared, "mergedPrsTruncated");

    expect(mergedPrsTileValue(undeclared)).toBe(MERGED_PRS_BARE);
  });

  it("separates thousands so a large floor stays readable", () => {
    expect(
      mergedPrsTileValue({ mergedPrs: 12_345, mergedPrsTruncated: true })
    ).toBe("12,345+");
  });

  it("dashes a count that was never computed, capped or not", () => {
    expect(
      mergedPrsTileValue({ mergedPrs: null, mergedPrsTruncated: true })
    ).toBe("—");
  });
});

describe("mergedPrsTileInfo (ISS-6462)", () => {
  it("names the scanned population and the cap when the count is capped", () => {
    const info = mergedPrsTileInfo(perf({ mergedPrsTruncated: true }));

    expect(info.what).toContain("At least this many");
    // The cap is read off the shared constant, never restated in copy.
    expect(info.how).toContain(COHORT_SCAN_CAP.toLocaleString("en-US"));
    expect(info.how).toContain("may be higher");
  });

  it("drops the full-cohort claim without asserting a cap when coverage is unknown", () => {
    const undeclared = perf();
    Reflect.deleteProperty(undeclared, "mergedPrsTruncated");
    const info = mergedPrsTileInfo(undeclared);

    expect(info.what).not.toContain("At least this many");
    expect(info.how).toContain("does not say whether");
  });

  it("keeps the plain claim when the producer declared whole-cohort coverage", () => {
    const info = mergedPrsTileInfo(perf({ mergedPrsTruncated: false }));

    expect(info.what).toBe(
      "Distinct merged PRs produced by the pack's sessions."
    );
    expect(info.how).toBeUndefined();
  });

  it("makes no coverage claim about a count that was never computed", () => {
    const info = mergedPrsTileInfo({
      mergedPrs: null,
      mergedPrsTruncated: true,
    });

    expect(info.what).toBe(
      "Distinct merged PRs produced by the pack's sessions."
    );
    expect(info.how).toBeUndefined();
  });
});
