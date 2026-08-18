/**
 * PRD-538 R6: when a session-limit snapshot stops being presentable as current.
 *
 * The boundary matters more than it looks. Too eager and a healthy app labels
 * itself "not updating" between refreshes; too lax and a snapshot that quietly
 * stopped updating keeps asserting a currency it does not have. Both directions
 * are asserted, plus the two inputs where claiming staleness would itself be an
 * invention.
 */
import { describe, expect, it } from "vitest";
import {
  isSessionLimitSnapshotStale,
  SESSION_LIMIT_STALE_DISPLAY_AFTER_MS,
} from "../freshness";

const NOW = new Date("2026-07-19T12:00:00.000Z");

function agedBy(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe("isSessionLimitSnapshotStale", () => {
  it("treats a snapshot inside the horizon as current", () => {
    expect(
      isSessionLimitSnapshotStale(
        agedBy(SESSION_LIMIT_STALE_DISPLAY_AFTER_MS - 1000),
        NOW
      )
    ).toBe(false);
  });

  it("does not flip exactly at the horizon", () => {
    // Inclusive boundary: a snapshot captured exactly one refresh cycle ago has
    // not yet missed a cycle, so labeling it would fire on every healthy app.
    expect(
      isSessionLimitSnapshotStale(
        agedBy(SESSION_LIMIT_STALE_DISPLAY_AFTER_MS),
        NOW
      )
    ).toBe(false);
  });

  it("marks a snapshot past the horizon as stale", () => {
    expect(
      isSessionLimitSnapshotStale(
        agedBy(SESSION_LIMIT_STALE_DISPLAY_AFTER_MS + 1000),
        NOW
      )
    ).toBe(true);
  });

  it("does not claim staleness with no capture time to date it to", () => {
    // No timestamp is "unknown", not "old" — asserting either way would invent
    // a fact the snapshot does not carry.
    expect(isSessionLimitSnapshotStale(null, NOW)).toBe(false);
    expect(isSessionLimitSnapshotStale(undefined, NOW)).toBe(false);
    expect(isSessionLimitSnapshotStale("not-a-date", NOW)).toBe(false);
  });

  it("does not call a future timestamp stale", () => {
    // Clock skew yields a negative age; it is not evidence of staleness.
    expect(isSessionLimitSnapshotStale(agedBy(-60_000), NOW)).toBe(false);
  });

  it("honours an injected horizon", () => {
    expect(isSessionLimitSnapshotStale(agedBy(2000), NOW, 1000)).toBe(true);
    expect(isSessionLimitSnapshotStale(agedBy(2000), NOW, 5000)).toBe(false);
  });
});
