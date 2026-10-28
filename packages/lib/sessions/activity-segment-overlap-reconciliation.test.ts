/**
 * ISS-4502 regression pin for ISS-5000 — "Session detail: activity-breakdown
 * phase costs sum to $32.84 while the same screen reports the total as $32.86".
 *
 * The fix is the honest `other` remainder in `buildActivitySegments`, and the
 * sibling suite already pins the reconciliation over a CONTIGUOUS tiling and
 * over gaps. Neither shape can break the property the finding is about: with
 * non-overlapping spans, a token event has at most one candidate phase whatever
 * the lookup does, so the sums reconcile by construction rather than by the
 * code being right.
 *
 * An OVERLAPPING tiling is where the lookup actually decides. `findContainingSpan`
 * binary-searches for the last span starting at or before the event, then walks
 * back over equal and overlapping starts — a loop that must return ONE span and
 * stop. If it ever accrued the event to every span covering it, the breakdown
 * would once again report parts that do not sum to the session's own total,
 * which is the defect, arriving from a different direction.
 *
 * The sibling suite does build one overlapping fixture (three rows sharing
 * `[0, 50)`), but it asserts only the key sort order and reads no cost or token
 * field off it, so the accrual under overlap is unexercised there.
 *
 * Which phase wins an overlap is a tie-break this file deliberately does not
 * pin. The finding is about the total, not the winner.
 */

import type { SyncedActivitySegmentRow } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { activitySegmentRow as row } from "./activity-segment-aggregation.test-fixtures.ts";
import {
  type ActivitySegmentTokenEvent,
  buildActivitySegments,
} from "./activity-segment-aggregation.ts";

/** `plan` and `implement` both cover [100, 200) — the contested window. */
const OVERLAPPING_TILING: SyncedActivitySegmentRow[] = [
  row({ phase: "plan", startMs: 0, endMs: 200 }),
  row({ phase: "implement", startMs: 100, endMs: 300 }),
];

/**
 * Three priced events, one of them (at 150ms) inside BOTH spans. The totals
 * below are written out rather than reduced from this array, so the expectation
 * cannot drift with the fixture the way a re-derived sum would.
 */
const EVENTS: ActivitySegmentTokenEvent[] = [
  {
    tMs: 50,
    costUsd: 1.0,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  {
    tMs: 150,
    costUsd: 2.0,
    inputTokens: 200,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  {
    tMs: 250,
    costUsd: 0.75,
    inputTokens: 50,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
];

/** 1.00 + 2.00 + 0.75, stated rather than summed from EVENTS. */
const TOTAL_COST_USD = 3.75;
/** 100 + 200 + 50. */
const TOTAL_INPUT_TOKENS = 350;

describe("ISS-5000: the activity breakdown sums to the session total on an overlapping tiling", () => {
  it("prices the contested event once across the whole breakdown", () => {
    const segments = buildActivitySegments(OVERLAPPING_TILING, EVENTS);

    const breakdownCost = segments.reduce(
      (sum, segment) => sum + segment.costUsd,
      0
    );
    const breakdownInput = segments.reduce(
      (sum, segment) => sum + segment.inputTokens,
      0
    );

    expect(breakdownCost).toBeCloseTo(TOTAL_COST_USD, 10);
    expect(breakdownInput).toBe(TOTAL_INPUT_TOKENS);
  });

  it("still reconciles when the overlap swallows an entire shorter phase", () => {
    const nested = [
      row({ phase: "plan", startMs: 0, endMs: 400 }),
      row({ phase: "review", startMs: 100, endMs: 200 }),
    ];

    const segments = buildActivitySegments(nested, EVENTS);
    const breakdownCost = segments.reduce(
      (sum, segment) => sum + segment.costUsd,
      0
    );

    expect(breakdownCost).toBeCloseTo(TOTAL_COST_USD, 10);
  });
});
