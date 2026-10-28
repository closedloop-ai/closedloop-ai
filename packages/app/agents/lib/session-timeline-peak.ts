import { getBucketCost } from "@repo/app/agents/components/detail/activity-bucket-rendering";
import {
  resolveProducerBinBounds,
  type TimelineSourceStrip,
} from "@repo/app/agents/lib/session-timeline-projection";
import {
  resolveTimelineColumnIndex,
  resolveTimelineScaleGeometry,
  type TimelineScale,
  timelineColumnStartMs,
} from "@repo/app/agents/lib/session-timeline-scale";

/**
 * ISS-12665 — the costliest column of the Session Timeline at `scale`, across
 * every column of the session rather than the 24-column window on screen.
 *
 * The prototype the ticket points at (`apps/prototypes/app/p/sessions/
 * components/session-timeline.tsx`) explains the figure as the "Highest-cost
 * {scale} interval across the full session", fixed while the reader scrolls. The
 * window is a viewport the scrubber moves, so a peak read off it would change as
 * the reader panned.
 *
 * Each column is priced by the same overlap-over-bin-width rule
 * `projectSessionTimeline` applies, on the same column grid and the same
 * `[0, totalColumns)` span, so the figure equals the tallest bar the reader can
 * scrub to.
 *
 * BOUNDED BY THE BINS, NOT THE SPAN (#9008 review, whitlockk). Pricing every column
 * made a corrupt far-future end timestamp walk millions of `5m` columns during
 * render. Only a column holding a bin edge can mix bins in a new proportion;
 * between two such columns every column is covered by the same bins, so its
 * cost is that set's cost per ms times the column's width, and the widest of
 * them is the peak of that run. So the work is the edge columns plus a widest
 * column per run, whatever the span.
 *
 * `null` when no bin is priced onto the grid, or when a bin's cost is corrupt
 * (non-finite or negative) — a dash, never a plausible wrong number.
 */
export function resolveTimelinePeakColumnCost({
  scale,
  source,
}: {
  scale: TimelineScale;
  source: TimelineSourceStrip;
}): number | null {
  const bins: PricedBin[] = [];
  for (const bucket of source.buckets) {
    const bounds = resolveProducerBinBounds(bucket);
    if (bounds == null) {
      continue;
    }
    const cost = getBucketCost(bucket);
    if (!Number.isFinite(cost) || cost < 0) {
      return null;
    }
    bins.push({ cost, endMs: bounds.endMs, startMs: bounds.startMs });
  }
  const { originMs, totalColumns } = resolveTimelineScaleGeometry({
    endMs: source.endMs,
    scale,
    startMs: source.startMs,
  });
  const grid: ColumnGrid = { originMs, scale, totalColumns };
  let peak: number | null = null;
  for (const column of resolveCandidateColumns(bins, grid)) {
    const cost = priceColumn(bins, grid, column);
    if (cost != null) {
      peak = Math.max(peak ?? 0, cost);
    }
  }
  return peak;
}

type PricedBin = {
  readonly cost: number;
  readonly endMs: number;
  readonly startMs: number;
};

type ColumnGrid = {
  readonly originMs: number;
  readonly scale: TimelineScale;
  readonly totalColumns: number;
};

/** A run longer than this is probed for its widest column instead of walked. */
const WALKED_RUN_COLUMNS = 8;
/** Columns kept at each end of a probed run, so a run's ordinary width is seen. */
const RUN_END_COLUMNS = 3;
const MS_PER_MINUTE = 60_000;
const WEEK_MS = 7 * 24 * 60 * MS_PER_MINUTE;
/**
 * A zone's UTC offset follows a yearly cycle, so a year of a run holds every
 * column width the run has. Exact for any run under a year — every real
 * session; a longer run comes only from a corrupt span, where this assumes the
 * zone's current yearly rule holds across it.
 */
const PROBED_SPAN_MS = 53 * WEEK_MS;

/** The edge columns, plus a widest column of each run between two of them. */
function resolveCandidateColumns(
  bins: readonly PricedBin[],
  grid: ColumnGrid
): Set<number> {
  const edgeColumns = [
    ...new Set(
      bins.flatMap((bin) => [
        columnOf(bin.startMs, grid),
        columnOf(bin.endMs, grid),
      ])
    ),
  ].sort((left, right) => left - right);
  const candidates = new Set(edgeColumns);
  for (const [index, edge] of edgeColumns.entries()) {
    const next = edgeColumns[index + 1];
    if (next != null && next - edge > 1) {
      for (const column of widestColumnCandidates(edge + 1, next - 1, grid)) {
        candidates.add(column);
      }
    }
  }
  return candidates;
}

/**
 * Columns of `[first, last]` that include a widest one. Widths differ only
 * where the UTC offset changes, so a long run keeps its ends (an ordinary
 * column) and the columns around each offset change found in its first year.
 */
function widestColumnCandidates(
  first: number,
  last: number,
  grid: ColumnGrid
): number[] {
  if (last - first < WALKED_RUN_COLUMNS) {
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  }
  const candidates: number[] = [];
  for (let offset = 0; offset < RUN_END_COLUMNS; offset += 1) {
    candidates.push(first + offset, last - offset);
  }
  const runStartMs = columnStartMs(first, grid);
  const probeEndMs = Math.min(
    columnStartMs(last + 1, grid),
    runStartMs + PROBED_SPAN_MS
  );
  for (const transitionMs of findOffsetChanges(runStartMs, probeEndMs)) {
    const column = columnOf(transitionMs, grid);
    for (const near of [column - 1, column, column + 1]) {
      if (near >= first && near <= last) {
        candidates.push(near);
      }
    }
  }
  return candidates;
}

/** Instants in `[startMs, endMs)` where the local UTC offset changes. */
function findOffsetChanges(startMs: number, endMs: number): number[] {
  const changes: number[] = [];
  let sampleMs = startMs;
  while (sampleMs < endMs) {
    const nextMs = Math.min(endMs, sampleMs + WEEK_MS);
    if (utcOffset(sampleMs) !== utcOffset(nextMs)) {
      changes.push(bisectOffsetChange(sampleMs, nextMs));
    }
    sampleMs = nextMs;
  }
  return changes;
}

/** The first instant after `beforeMs` on `afterMs`'s offset, to the minute. */
function bisectOffsetChange(beforeMs: number, afterMs: number): number {
  const beforeOffset = utcOffset(beforeMs);
  let low = beforeMs;
  let high = afterMs;
  while (high - low > MS_PER_MINUTE) {
    const middle = low + Math.floor((high - low) / 2);
    if (utcOffset(middle) === beforeOffset) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return high;
}

function utcOffset(instantMs: number): number {
  return new Date(instantMs).getTimezoneOffset();
}

/**
 * One column's cost, summed bin by bin exactly as `accumulateSourceBin` does;
 * `null` when no bin overlaps it, which the projection leaves an empty column.
 */
function priceColumn(
  bins: readonly PricedBin[],
  grid: ColumnGrid,
  column: number
): number | null {
  const startMs = columnStartMs(column, grid);
  const endMs = columnStartMs(column + 1, grid);
  let cost: number | null = null;
  for (const bin of bins) {
    const overlapMs =
      Math.min(bin.endMs, endMs) - Math.max(bin.startMs, startMs);
    if (overlapMs > 0) {
      cost = (cost ?? 0) + bin.cost * (overlapMs / (bin.endMs - bin.startMs));
    }
  }
  return cost;
}

/** The grid column holding `instantMs`, clamped onto `[0, totalColumns)`. */
function columnOf(instantMs: number, grid: ColumnGrid): number {
  const column = resolveTimelineColumnIndex({
    instantMs,
    originMs: grid.originMs,
    scale: grid.scale,
  });
  return Math.min(grid.totalColumns - 1, Math.max(0, column));
}

function columnStartMs(columnIndex: number, grid: ColumnGrid): number {
  return timelineColumnStartMs({
    columnIndex,
    originMs: grid.originMs,
    scale: grid.scale,
  });
}
