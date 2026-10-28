import type {
  BranchMetricResult,
  BranchMetricSeries,
  BranchMetricWindow,
} from "@repo/api/src/types/branch-metrics";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Most sub-windows a series is cut into.
 *
 * The mark it feeds is 26x11 CSS pixels (`MetricCard`'s delta-slot sparkline),
 * so past roughly a dozen points the line stops carrying shape and starts
 * carrying noise. A 7-day period therefore gets daily buckets and a 90-day one
 * gets ~7.5-day buckets, rather than every period being cut to the same cadence.
 */
export const BRANCH_METRIC_SERIES_MAX_BUCKETS = 12;

/**
 * Two points make a line; one is a dot claiming to be a trend.
 *
 * It bounds both halves because it is one fact: a window too short to hold two
 * buckets cannot yield two points, and a line whose buckets were all unknown but
 * one has not got two either.
 */
const MIN_SERIES_POINTS = 2;

/**
 * Cut a metric window into equal, adjacent, half-open sub-windows, oldest
 * first (ISS-10363).
 *
 * Equal width and exact adjacency are what make the points comparable to each
 * other AND make their evidence a partition of the headline figure's: every
 * instant in the window falls in exactly one bucket, so no evidence is counted
 * twice and none is dropped. Each bucket's bounds are then handed to the SAME
 * per-window fold the headline uses, which is why a point can never be a second,
 * independently-derived number that disagrees with the figure above it.
 *
 * Returns no buckets — a genuinely absent series, not an empty one — when the
 * window has no lower bound (the all-time range, which is unbounded and cannot
 * be cut into equal spans), when either bound is unparseable, or when the span
 * is too short to hold {@link MIN_SERIES_POINTS} whole days.
 */
export function buildBranchMetricSeriesWindows(
  window: BranchMetricWindow
): BranchMetricWindow[] {
  if (window.startAt === null) {
    return [];
  }
  const startMs = Date.parse(window.startAt);
  const endMs = Date.parse(window.endAt);
  if (!(Number.isFinite(startMs) && Number.isFinite(endMs))) {
    return [];
  }
  const durationMs = endMs - startMs;
  const bucketCount = Math.min(
    BRANCH_METRIC_SERIES_MAX_BUCKETS,
    Math.floor(durationMs / DAY_MS)
  );
  if (bucketCount < MIN_SERIES_POINTS) {
    return [];
  }
  const windows: BranchMetricWindow[] = [];
  for (let index = 0; index < bucketCount; index += 1) {
    // The LAST bucket takes the window's own end instant rather than a
    // recomputed one, so rounding can never leave a sliver of the period
    // outside every bucket — the points would then sum to less than the figure
    // they sit under.
    const bucketEndMs =
      index === bucketCount - 1
        ? endMs
        : startMs + Math.round(((index + 1) * durationMs) / bucketCount);
    windows.push({
      startAt: new Date(
        startMs + Math.round((index * durationMs) / bucketCount)
      ).toISOString(),
      endAt: new Date(bucketEndMs).toISOString(),
    });
  }
  return windows;
}

/**
 * One metric's line across the bucket folds, or nothing.
 *
 * A bucket the producer could not compute is `null` — a gap in the line — and
 * never a zero, which would read as a measured quiet day. A series with fewer
 * than two real points is omitted entirely rather than sent as a stub the
 * consumer has to re-judge: with one point there is no shape to draw.
 */
export function bucketSeries<Metrics>(
  buckets: readonly Metrics[],
  pick: (bucket: Metrics) => BranchMetricResult<number>
): BranchMetricSeries | undefined {
  const points = buckets.map((bucket) => pick(bucket).value);
  const finite = points.filter(
    (point) => point !== null && Number.isFinite(point)
  ).length;
  return finite >= MIN_SERIES_POINTS ? points : undefined;
}
