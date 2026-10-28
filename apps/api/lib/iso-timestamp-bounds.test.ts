/**
 * The helper exists because two copies of this fold had already drifted —
 * `Date.parse` in one, raw string comparison in the other. A test that only
 * compares `Z` timestamps cannot tell those two implementations apart, so the
 * mixed-offset cases below are the ones that actually pin the contract.
 */

import { describe, expect, it } from "vitest";
import { earliestTimestamp, latestTimestamp } from "./iso-timestamp-bounds";

// Instant 2025-12-31T22:00:00Z, one hour BEFORE the Z timestamp it is paired
// with — but lexically GREATER than it, because "2026" sorts after "2025".
// Raw string comparison and instant comparison give opposite answers here.
const OFFSET_EARLIER = "2026-01-01T00:00:00+02:00";
const Z_LATER = "2025-12-31T23:00:00Z";

const FIRST = "2026-01-01T00:00:00.000Z";
const SECOND = "2026-06-01T00:00:00.000Z";
const UNPARSEABLE = "not-a-timestamp";
// Only the garbage-on-the-LEFT direction is pinned below. With garbage on the
// right, `Date.parse` yields `NaN`, every comparison is false, and the garbage
// is returned — contradicting this helper's docstring ("a defined timestamp is
// preferred over a garbage one"). That asymmetry is a defect, not a contract,
// so it is deliberately left unasserted: pinning it would mean the eventual fix
// has to fight this suite first (whitlockk, PR #5767).

describe("earliestTimestamp", () => {
  it("returns the other side when one is absent", () => {
    expect(earliestTimestamp(null, FIRST)).toBe(FIRST);
    expect(earliestTimestamp(undefined, FIRST)).toBe(FIRST);
    expect(earliestTimestamp(FIRST, null)).toBe(FIRST);
    expect(earliestTimestamp(FIRST, undefined)).toBe(FIRST);
  });

  it("normalizes both-absent to null rather than undefined", () => {
    expect(earliestTimestamp(null, null)).toBeNull();
    expect(earliestTimestamp(undefined, undefined)).toBeNull();
    expect(earliestTimestamp(null, undefined)).toBeNull();
  });

  it("treats the empty string as absent", () => {
    expect(earliestTimestamp("", FIRST)).toBe(FIRST);
    expect(earliestTimestamp(FIRST, "")).toBe(FIRST);
  });

  it("picks the earlier instant when both are Z timestamps", () => {
    expect(earliestTimestamp(FIRST, SECOND)).toBe(FIRST);
    expect(earliestTimestamp(SECOND, FIRST)).toBe(FIRST);
  });

  it("compares the instant, not the spelling, across a non-Z offset", () => {
    expect(earliestTimestamp(OFFSET_EARLIER, Z_LATER)).toBe(OFFSET_EARLIER);
    expect(earliestTimestamp(Z_LATER, OFFSET_EARLIER)).toBe(OFFSET_EARLIER);
    // Guards the guard: raw string comparison would answer the other way, so a
    // regression back to string compare cannot pass the two assertions above.
    expect([OFFSET_EARLIER, Z_LATER].sort()[0]).toBe(Z_LATER);
  });

  it("keeps the left side on an exact tie", () => {
    const sameInstantDifferentSpelling = "2026-01-01T00:00:00.000+00:00";
    expect(earliestTimestamp(FIRST, sameInstantDifferentSpelling)).toBe(FIRST);
    expect(earliestTimestamp(sameInstantDifferentSpelling, FIRST)).toBe(
      sameInstantDifferentSpelling
    );
  });

  it("prefers the defined timestamp over an unparseable left side", () => {
    expect(earliestTimestamp(UNPARSEABLE, FIRST)).toBe(FIRST);
  });
});

describe("latestTimestamp", () => {
  it("returns the other side when one is absent", () => {
    expect(latestTimestamp(null, FIRST)).toBe(FIRST);
    expect(latestTimestamp(undefined, FIRST)).toBe(FIRST);
    expect(latestTimestamp(FIRST, null)).toBe(FIRST);
    expect(latestTimestamp(FIRST, undefined)).toBe(FIRST);
  });

  it("normalizes both-absent to null rather than undefined", () => {
    expect(latestTimestamp(null, null)).toBeNull();
    expect(latestTimestamp(undefined, undefined)).toBeNull();
    expect(latestTimestamp(null, undefined)).toBeNull();
  });

  it("treats the empty string as absent", () => {
    expect(latestTimestamp("", FIRST)).toBe(FIRST);
    expect(latestTimestamp(FIRST, "")).toBe(FIRST);
  });

  it("picks the later instant when both are Z timestamps", () => {
    expect(latestTimestamp(FIRST, SECOND)).toBe(SECOND);
    expect(latestTimestamp(SECOND, FIRST)).toBe(SECOND);
  });

  it("compares the instant, not the spelling, across a non-Z offset", () => {
    expect(latestTimestamp(OFFSET_EARLIER, Z_LATER)).toBe(Z_LATER);
    expect(latestTimestamp(Z_LATER, OFFSET_EARLIER)).toBe(Z_LATER);
    expect([OFFSET_EARLIER, Z_LATER].sort()[1]).toBe(OFFSET_EARLIER);
  });

  it("keeps the left side on an exact tie", () => {
    const sameInstantDifferentSpelling = "2026-01-01T00:00:00.000+00:00";
    expect(latestTimestamp(FIRST, sameInstantDifferentSpelling)).toBe(FIRST);
    expect(latestTimestamp(sameInstantDifferentSpelling, FIRST)).toBe(
      sameInstantDifferentSpelling
    );
  });

  it("prefers the defined timestamp over an unparseable left side", () => {
    expect(latestTimestamp(UNPARSEABLE, FIRST)).toBe(FIRST);
  });
});

describe("earliestTimestamp / latestTimestamp agreement", () => {
  it("select opposite sides of the same pair", () => {
    for (const [left, right] of [
      [FIRST, SECOND],
      [SECOND, FIRST],
      [OFFSET_EARLIER, Z_LATER],
      [Z_LATER, OFFSET_EARLIER],
    ]) {
      expect(earliestTimestamp(left, right)).not.toBe(
        latestTimestamp(left, right)
      );
    }
  });
});
