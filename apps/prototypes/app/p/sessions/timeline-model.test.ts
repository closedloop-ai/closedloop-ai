import { describe, expect, it } from "vitest";
import {
  defaultTimelineScale,
  TimelineScale,
  timelineBucketIndex,
  timelineWindowStart,
} from "./timeline-model";

describe("timeline model", () => {
  it.each([
    [120, TimelineScale.FiveMinutes],
    [121, TimelineScale.FifteenMinutes],
    [360, TimelineScale.FifteenMinutes],
    [361, TimelineScale.OneHour],
    [1440, TimelineScale.OneHour],
    [1441, TimelineScale.TwelveHours],
  ] as const)("selects the duration scale at %i minutes", (minutes, scale) => {
    expect(defaultTimelineScale(minutes)).toBe(scale);
  });

  it("aligns the first and boundary buckets from the clock offset", () => {
    expect(timelineBucketIndex(0, 14, 60)).toBe(0);
    expect(timelineBucketIndex(45, 14, 60)).toBe(0);
    expect(timelineBucketIndex(46, 14, 60)).toBe(1);
  });

  it("keeps visible selections stable and scrolls only at window edges", () => {
    expect(timelineWindowStart(12, 0, 50)).toBe(0);
    expect(timelineWindowStart(24, 0, 50)).toBe(1);
    expect(timelineWindowStart(8, 10, 50)).toBe(8);
    expect(timelineWindowStart(74, 50, 50)).toBe(50);
  });
});
