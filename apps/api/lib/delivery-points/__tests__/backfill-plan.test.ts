import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_BACKFILL_SEGMENTS,
  isPlanTruncated,
  planBackfillSegments,
} from "../backfill-plan";

const END = new Date("2026-08-04T13:45:00.000Z");

/** Each guard names the input it refused, so the message is the assertion. */
const LOOKBACK_DAYS_RE = /lookbackDays/;
const SEGMENT_DAYS_RE = /segmentDays/;
const MAX_SEGMENTS_RE = /maxSegments/;
const END_DATE_RE = /endDate/;

describe("planBackfillSegments", () => {
  it("covers the lookback newest-first in inclusive windows", () => {
    expect(
      planBackfillSegments({ endDate: END, lookbackDays: 8, segmentDays: 4 })
    ).toEqual([
      { startDate: "2026-08-01", endDate: "2026-08-04" },
      { startDate: "2026-07-28", endDate: "2026-07-31" },
    ]);
  });

  it("truncates the oldest window at the lookback rather than overshooting it", () => {
    const segments = planBackfillSegments({
      endDate: END,
      lookbackDays: 5,
      segmentDays: 4,
    });
    expect(segments).toEqual([
      { startDate: "2026-08-01", endDate: "2026-08-04" },
      { startDate: "2026-07-31", endDate: "2026-07-31" },
    ]);
  });

  it("normalizes the end instant to a calendar day so two runs agree", () => {
    const earlier = planBackfillSegments({
      endDate: new Date("2026-08-04T00:00:01.000Z"),
      lookbackDays: 2,
      segmentDays: 1,
    });
    const later = planBackfillSegments({
      endDate: new Date("2026-08-04T23:59:59.000Z"),
      lookbackDays: 2,
      segmentDays: 1,
    });
    expect(earlier).toEqual(later);
  });

  it("clamps both sizes at the low end instead of looping or planning nothing", () => {
    // `Math.min` alone would let a zero segment size spin forever and a
    // negative lookback produce an empty plan that reads as a completed run.
    expect(
      planBackfillSegments({ endDate: END, lookbackDays: 0, segmentDays: 0 })
    ).toEqual([{ startDate: "2026-08-04", endDate: "2026-08-04" }]);
    expect(
      planBackfillSegments({ endDate: END, lookbackDays: -5, segmentDays: -5 })
    ).toEqual([{ startDate: "2026-08-04", endDate: "2026-08-04" }]);
  });

  it("stops at maxSegments so a mis-set lookback cannot fan out", () => {
    const segments = planBackfillSegments({
      endDate: END,
      lookbackDays: 3650,
      segmentDays: 1,
      maxSegments: 3,
    });
    expect(segments).toHaveLength(3);
    expect(segments[0].endDate).toBe("2026-08-04");
    expect(segments[2].startDate).toBe("2026-08-02");
  });

  it("defaults the ceiling rather than leaving it unbounded", () => {
    expect(
      planBackfillSegments({ endDate: END, lookbackDays: 3650, segmentDays: 1 })
    ).toHaveLength(DEFAULT_MAX_BACKFILL_SEGMENTS);
  });

  it("refuses a non-finite size instead of planning an empty run that reads as complete", () => {
    // NaN SURVIVES `Math.max(1, Math.floor(NaN))`, and a NaN lookback yields an
    // empty plan with `planTruncated` false — a mis-set config byte-identical
    // to a run that asked for everything and found a quiet period.
    expect(() =>
      planBackfillSegments({
        endDate: END,
        lookbackDays: Number.NaN,
        segmentDays: 4,
      })
    ).toThrow(LOOKBACK_DAYS_RE);
    expect(() =>
      planBackfillSegments({
        endDate: END,
        lookbackDays: 8,
        segmentDays: Number.NaN,
      })
    ).toThrow(SEGMENT_DAYS_RE);
    expect(() =>
      planBackfillSegments({
        endDate: END,
        lookbackDays: 8,
        segmentDays: 4,
        maxSegments: Number.POSITIVE_INFINITY,
      })
    ).toThrow(MAX_SEGMENTS_RE);
  });

  it("refuses an Invalid Date, which reaches the same empty plan", () => {
    expect(() =>
      planBackfillSegments({
        endDate: new Date("not a date"),
        lookbackDays: 8,
        segmentDays: 4,
      })
    ).toThrow(END_DATE_RE);
  });
});

describe("isPlanTruncated", () => {
  it("is false when the plan covers the requested lookback", () => {
    const input = { endDate: END, lookbackDays: 8, segmentDays: 4 };
    expect(isPlanTruncated(input, planBackfillSegments(input))).toBe(false);
  });

  it("is true when the ceiling cut the plan short", () => {
    // A run that silently covered less than it was asked to would report a
    // shorter history as if it were the whole history.
    const input = {
      endDate: END,
      lookbackDays: 30,
      segmentDays: 1,
      maxSegments: 3,
    };
    expect(isPlanTruncated(input, planBackfillSegments(input))).toBe(true);
  });

  it("refuses a non-finite size rather than answering false about a plan it cannot size", () => {
    // `Math.ceil(NaN / NaN)` is NaN and `length < NaN` is false, so the old
    // clamp reported "not truncated" for a plan it never sized.
    expect(() =>
      isPlanTruncated(
        { endDate: END, lookbackDays: Number.NaN, segmentDays: 4 },
        []
      )
    ).toThrow(LOOKBACK_DAYS_RE);
  });
});
