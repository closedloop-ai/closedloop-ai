export const TimelineScale = {
  FiveMinutes: "5m",
  FifteenMinutes: "15m",
  OneHour: "1h",
  TwelveHours: "12h",
} as const;

export type TimelineScale = (typeof TimelineScale)[keyof typeof TimelineScale];

export const SCALE_MINUTES: Record<TimelineScale, number> = {
  [TimelineScale.FiveMinutes]: 5,
  [TimelineScale.FifteenMinutes]: 15,
  [TimelineScale.OneHour]: 60,
  [TimelineScale.TwelveHours]: 12 * 60,
};

export function defaultTimelineScale(durationMinutes: number): TimelineScale {
  if (durationMinutes <= 2 * 60) {
    return TimelineScale.FiveMinutes;
  }
  if (durationMinutes <= 6 * 60) {
    return TimelineScale.FifteenMinutes;
  }
  if (durationMinutes <= 24 * 60) {
    return TimelineScale.OneHour;
  }
  return TimelineScale.TwelveHours;
}

export function timelineBucketIndex(
  activeMinutes: number,
  sessionStartOffsetMinutes: number,
  scaleMinutes: number
): number {
  return Math.floor((sessionStartOffsetMinutes + activeMinutes) / scaleMinutes);
}

export function timelineWindowStart(
  activeBucket: number,
  currentWindowStart: number,
  maxWindowStart: number,
  visibleBars = 24
): number {
  if (activeBucket < currentWindowStart) {
    return Math.max(0, activeBucket);
  }
  if (activeBucket >= currentWindowStart + visibleBars) {
    return Math.min(maxWindowStart, activeBucket - visibleBars + 1);
  }
  return currentWindowStart;
}
