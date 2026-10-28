/**
 * @file branch-check-projection.test.ts
 * @description Pins the check-row classifier's exhaustive bucket table and the
 * whole-population completeness predicate.
 */
import { describe, expect, it } from "vitest";
import {
  CheckRowOutcomeBucket,
  checkRowOutcomeBucket,
  isWholeMeasuredPopulation,
} from "./branch-check-projection.ts";

describe("checkRowOutcomeBucket", () => {
  it("classifies every known passed conclusion", () => {
    expect(checkRowOutcomeBucket(null, "SUCCESS")).toBe(
      CheckRowOutcomeBucket.Passed
    );
  });

  it("classifies every known failed conclusion", () => {
    expect(checkRowOutcomeBucket(null, "FAILURE")).toBe(
      CheckRowOutcomeBucket.Failed
    );
    expect(checkRowOutcomeBucket(null, "ERROR")).toBe(
      CheckRowOutcomeBucket.Failed
    );
    expect(checkRowOutcomeBucket(null, "TIMED_OUT")).toBe(
      CheckRowOutcomeBucket.Failed
    );
    expect(checkRowOutcomeBucket(null, "ACTION_REQUIRED")).toBe(
      CheckRowOutcomeBucket.Failed
    );
    expect(checkRowOutcomeBucket(null, "STARTUP_FAILURE")).toBe(
      CheckRowOutcomeBucket.Failed
    );
  });

  it("classifies every known inconclusive conclusion", () => {
    expect(checkRowOutcomeBucket(null, "CANCELLED")).toBe(
      CheckRowOutcomeBucket.Inconclusive
    );
    expect(checkRowOutcomeBucket(null, "SKIPPED")).toBe(
      CheckRowOutcomeBucket.Inconclusive
    );
    expect(checkRowOutcomeBucket(null, "STALE")).toBe(
      CheckRowOutcomeBucket.Inconclusive
    );
    expect(checkRowOutcomeBucket(null, "NEUTRAL")).toBe(
      CheckRowOutcomeBucket.Inconclusive
    );
  });

  it("classifies every known pending status", () => {
    expect(checkRowOutcomeBucket("QUEUED", null)).toBe(
      CheckRowOutcomeBucket.Pending
    );
    expect(checkRowOutcomeBucket("IN_PROGRESS", null)).toBe(
      CheckRowOutcomeBucket.Pending
    );
    expect(checkRowOutcomeBucket("PENDING", null)).toBe(
      CheckRowOutcomeBucket.Pending
    );
    expect(checkRowOutcomeBucket("EXPECTED", null)).toBe(
      CheckRowOutcomeBucket.Pending
    );
    expect(checkRowOutcomeBucket("WAITING", null)).toBe(
      CheckRowOutcomeBucket.Pending
    );
    expect(checkRowOutcomeBucket("REQUESTED", null)).toBe(
      CheckRowOutcomeBucket.Pending
    );
  });

  it("prefers conclusion over status when both are present", () => {
    expect(checkRowOutcomeBucket("IN_PROGRESS", "SUCCESS")).toBe(
      CheckRowOutcomeBucket.Passed
    );
  });

  it("falls back to status when conclusion is null", () => {
    expect(checkRowOutcomeBucket("QUEUED", null)).toBe(
      CheckRowOutcomeBucket.Pending
    );
  });

  it("returns null when neither status nor conclusion is reported", () => {
    expect(checkRowOutcomeBucket(null, null)).toBeNull();
  });

  it("returns null for a word outside the provider vocabulary rather than guessing", () => {
    expect(checkRowOutcomeBucket(null, "SOMETHING_NEW")).toBeNull();
  });

  it("trims and case-normalizes the reported word before lookup", () => {
    expect(checkRowOutcomeBucket(null, "  success  ")).toBe(
      CheckRowOutcomeBucket.Passed
    );
  });
});

describe("isWholeMeasuredPopulation", () => {
  it("returns true when untruncated and item count equals totalCount", () => {
    expect(
      isWholeMeasuredPopulation({
        truncated: false,
        totalCount: 3,
        items: [1, 2, 3],
      })
    ).toBe(true);
  });

  it("returns false when truncated is true, even if counts happen to match", () => {
    expect(
      isWholeMeasuredPopulation({
        truncated: true,
        totalCount: 3,
        items: [1, 2, 3],
      })
    ).toBe(false);
  });

  it("returns false when item count is short of totalCount", () => {
    expect(
      isWholeMeasuredPopulation({
        truncated: false,
        totalCount: 3,
        items: [1, 2],
      })
    ).toBe(false);
  });

  it("returns true for an empty, untruncated, zero-total population", () => {
    expect(
      isWholeMeasuredPopulation({ truncated: false, totalCount: 0, items: [] })
    ).toBe(true);
  });
});
