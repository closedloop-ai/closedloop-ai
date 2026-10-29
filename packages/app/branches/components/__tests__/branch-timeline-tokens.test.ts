import { describe, expect, it } from "vitest";
import { formatTimelineTokens } from "../branch-pr-activity-timeline-helpers";

/**
 * ISS-5746 was a CARRY defect: only the band immediately under a tier ceiling,
 * where rounding carries to `1000.0`, produced the non-canonical `1000k` /
 * `1000M`. A comfortable value inside a tier cannot detect it, so every row here
 * sits at a threshold.
 *
 * 1,000,000 is the value the ticket names, but it rendered `1M` before the fix
 * too. The band that actually rendered `1000k` was 999,500-999,999 (the pre-fix
 * k tier was `Math.round(rounded / 1e3)`, 0dp), which is why `999_999` is pinned
 * beside it: the carry band and the real tier entry must read as one unit.
 *
 * Each threshold carries the value below it and the value above it, and the two
 * catch different mistakes. Below (`999_949`) fails if the carry fires early;
 * AT (`999_950`) fails if the guard becomes `>`; ABOVE (`999_951`) fails if it
 * becomes `===`, which passes the boundary and drops the rest of the band.
 */
const TIER_LADDER: readonly [number, string][] = [
  [999, "999"],
  [1000, "1k"],
  [999_949, "999.9k"],
  [999_950, "1M"],
  [999_951, "1M"],
  [999_999, "1M"],
  [1_000_000, "1M"],
  [999_949_999, "999.9M"],
  [999_950_000, "1B"],
  [999_950_001, "1B"],
  [999_999_999, "1B"],
  [1_000_000_000, "1B"],
];

/**
 * The pre-ISS-5746 compactor had no `Math.abs`, so a negative bucket fell
 * through every tier to a raw `-999950`. These pin that a negative compacts
 * inside a tier and carries across one, like its positive twin.
 */
const NEGATIVE_LADDER: readonly [number, string][] = [
  [-1500, "-1.5k"],
  [-999_950, "-1M"],
];

/**
 * Bucket tokens are apportioned across hours by span fraction, so the input is
 * routinely fractional. Rounding happens BEFORE compacting: `999_949.6` is
 * below the carry threshold as a fraction and above it as a token count, and a
 * magnitude that rounds to zero has no figure to show at all.
 */
const FRACTIONAL_INPUTS: readonly [number, string][] = [
  [999_949.6, "1M"],
  [0.4, "—"],
  [-0.4, "—"],
];

describe("formatTimelineTokens", () => {
  it.each(TIER_LADDER)("compacts %d tokens as %s", (value, expected) => {
    expect(formatTimelineTokens(value)).toBe(expected);
  });

  it.each(NEGATIVE_LADDER)("compacts %d tokens as %s", (value, expected) => {
    expect(formatTimelineTokens(value)).toBe(expected);
  });

  it.each(FRACTIONAL_INPUTS)(
    "rounds %d to whole tokens before compacting, giving %s",
    (value, expected) => {
      expect(formatTimelineTokens(value)).toBe(expected);
    }
  );

  it("keeps a dash for a split with no tokens rather than a real zero", () => {
    expect(formatTimelineTokens(0)).toBe("—");
  });

  it("keeps a dash when a bucket has no token figure at all", () => {
    expect(formatTimelineTokens(Number.NaN)).toBe("—");
  });
});
