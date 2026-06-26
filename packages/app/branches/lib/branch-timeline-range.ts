/**
 * Shared time-axis math (Epic E / E2) for the Branch timeline (E1), playhead
 * scrubber (E2), event-dot rail (E3), and swimlane (E4). One source for the
 * axis so the four visuals stay aligned when stacked.
 */

const HOUR_MS = 3_600_000;

export type TimeRange = {
  startMs: number;
  endMs: number;
  spanMs: number;
};

/**
 * Min/max extent across ISO `hourStart` strings. Each hour bucket spans one
 * hour, so the range end is the last hour's start + 1h. Returns null when no
 * timestamp parses.
 */
export function hourRange(hourStarts: readonly string[]): TimeRange | null {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const hourStart of hourStarts) {
    const ms = Date.parse(hourStart);
    if (Number.isNaN(ms)) {
      continue;
    }
    startMs = Math.min(startMs, ms);
    endMs = Math.max(endMs, ms + HOUR_MS);
  }
  if (startMs === Number.POSITIVE_INFINITY) {
    return null;
  }
  return { startMs, endMs, spanMs: Math.max(1, endMs - startMs) };
}

/**
 * Min start / max end across ISO start + (nullable) end pairs. Starts also fold
 * into the max so a session with no `endedAt` still bounds the range. Returns
 * null when nothing parses.
 */
export function timeRange(
  starts: readonly string[],
  ends: readonly (string | null)[]
): TimeRange | null {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const start of starts) {
    const ms = Date.parse(start);
    if (!Number.isNaN(ms)) {
      startMs = Math.min(startMs, ms);
      endMs = Math.max(endMs, ms);
    }
  }
  for (const end of ends) {
    if (end == null) {
      continue;
    }
    const ms = Date.parse(end);
    if (!Number.isNaN(ms)) {
      endMs = Math.max(endMs, ms);
    }
  }
  if (
    startMs === Number.POSITIVE_INFINITY ||
    endMs === Number.NEGATIVE_INFINITY
  ) {
    return null;
  }
  return { startMs, endMs, spanMs: Math.max(1, endMs - startMs) };
}

/** Position (0..1) of a timestamp within a range, clamped to the ends. */
export function fractionOf(range: TimeRange, ms: number): number {
  return Math.min(1, Math.max(0, (ms - range.startMs) / range.spanMs));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Local-time clock label ("Mon 2pm" / "Mon 2:50pm") — the design handoff's
 * `bqFmtClock`. Minutes are dropped on the hour. Shared by the timeline axis,
 * the bar tooltip, and the event-dot tooltip so they read identically.
 */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  const rawHour = date.getHours();
  const suffix = rawHour < 12 ? "am" : "pm";
  const hour = rawHour % 12 || 12;
  const minutes = date.getMinutes();
  const mm = minutes ? `:${String(minutes).padStart(2, "0")}` : "";
  return `${WEEKDAYS[date.getDay()]} ${hour}${mm}${suffix}`;
}
