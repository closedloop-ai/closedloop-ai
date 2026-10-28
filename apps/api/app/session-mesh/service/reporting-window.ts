const DAY_MS = 86_400_000;

/** Retention is ninety days; allow one minute for request transit at the edge. */
export function isRetainedReportingWindow(from: Date, to: Date, now: Date) {
  return (
    Number.isFinite(from.getTime()) &&
    Number.isFinite(to.getTime()) &&
    from <= to &&
    to.getTime() - from.getTime() <= 90 * DAY_MS &&
    from.getTime() >= now.getTime() - 90 * DAY_MS - 60_000
  );
}
