import { describe, expect, it } from "vitest";
import {
  BRANCH_METRIC_SERIES_MAX_BUCKETS,
  buildBranchMetricSeriesWindows,
} from "./branch-metric-series";

const END = "2026-08-03T21:00:00.000Z";

function windowOf(days: number) {
  const endMs = Date.parse(END);
  return {
    startAt: new Date(endMs - days * 24 * 60 * 60 * 1000).toISOString(),
    endAt: END,
  };
}

describe("branch metric series windows (ISS-10363)", () => {
  it("cuts a seven-day window into seven daily buckets", () => {
    const buckets = buildBranchMetricSeriesWindows(windowOf(7));
    expect(buckets).toHaveLength(7);
    expect(buckets[0].startAt).toBe(windowOf(7).startAt);
    expect(buckets[0].endAt).toBe(windowOf(6).startAt);
  });

  it("caps a long window rather than drawing a point per day", () => {
    expect(buildBranchMetricSeriesWindows(windowOf(90))).toHaveLength(
      BRANCH_METRIC_SERIES_MAX_BUCKETS
    );
  });

  it("partitions the window exactly: adjacent buckets, ending where it ends", () => {
    // The points must fold the SAME evidence the headline folds. A gap between
    // two buckets drops evidence from the line, and an overlap counts it twice —
    // either way the line stops describing the figure it sits under.
    const source = windowOf(30);
    const buckets = buildBranchMetricSeriesWindows(source);
    expect(buckets[0].startAt).toBe(source.startAt);
    expect(buckets.at(-1)?.endAt).toBe(source.endAt);
    for (let index = 1; index < buckets.length; index += 1) {
      expect(buckets[index].startAt).toBe(buckets[index - 1].endAt);
    }
  });

  it("gives an unbounded window no series at all", () => {
    // All-time has no lower bound, so there is nothing to cut into equal spans;
    // an invented one would put a start instant on the card's line that the
    // figure above it does not have.
    expect(
      buildBranchMetricSeriesWindows({ startAt: null, endAt: END })
    ).toEqual([]);
  });

  it("gives a window too short for two whole days no series", () => {
    expect(buildBranchMetricSeriesWindows(windowOf(1))).toEqual([]);
  });

  it("gives an unparseable window no series", () => {
    expect(
      buildBranchMetricSeriesWindows({ startAt: "not-a-date", endAt: END })
    ).toEqual([]);
  });
});
