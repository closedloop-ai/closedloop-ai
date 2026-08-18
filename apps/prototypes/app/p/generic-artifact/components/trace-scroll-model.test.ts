import { describe, expect, it } from "vitest";
import {
  interpolateMinutesAtY,
  interpolateYAtMinutes,
  nearestAnchorAtY,
  nextScrollFollowY,
  type TracePositionAnchor,
} from "./trace-scroll-model";

const anchors: readonly TracePositionAnchor[] = [
  { minutes: 0, row: 0, y: 100 },
  { minutes: 60, row: 1, y: 220 },
  { minutes: 360, row: 2, y: 340 },
];

describe("trace scroll normalization", () => {
  it("interpolates elapsed time across unequal time gaps", () => {
    expect(interpolateMinutesAtY(anchors, 160)).toBe(30);
    expect(interpolateMinutesAtY(anchors, 280)).toBe(210);
  });

  it("maps elapsed time back to proportional transcript positions", () => {
    expect(interpolateYAtMinutes(anchors, 30)).toBe(160);
    expect(interpolateYAtMinutes(anchors, 210)).toBe(280);
  });

  it("clamps beyond the trace and selects the nearest visible row", () => {
    expect(interpolateMinutesAtY(anchors, 0)).toBe(0);
    expect(interpolateYAtMinutes(anchors, 500)).toBe(340);
    expect(nearestAnchorAtY(anchors, 270).row).toBe(1);
    expect(nearestAnchorAtY(anchors, 290).row).toBe(2);
  });

  it("limits large scrubber-driven jumps to a stable per-frame velocity", () => {
    expect(nextScrollFollowY(0, 10_000, 16, 5000)).toBe(80);
    expect(nextScrollFollowY(10_000, 0, 16, 5000)).toBe(9920);
  });

  it("damps small deltas and converges exactly at the target", () => {
    const next = nextScrollFollowY(100, 120, 16, 5000);
    expect(next).toBeGreaterThan(100);
    expect(next).toBeLessThan(120);
    expect(nextScrollFollowY(119.6, 120, 16, 5000)).toBe(120);
  });
});
