import type {
  ActivityBucket,
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import type { ActivityMarker } from "@repo/app/agents/components/detail/session-timeline-axis";
import { formatMarkerTime } from "@repo/app/agents/lib/session-marker-time";
import {
  alignBucketRowsToTranscript,
  getBucketIndexFromMs,
  getTimedRowBounds,
  getTurnItemMs,
  hasTimedTraceRow,
  hasTraceRow,
  type SessionTimelineWindow,
} from "@repo/app/agents/lib/session-timeline-geometry";
import { formatTime } from "@repo/app/shared/lib/date-utils";

/**
 * The Session Timeline's bars, plus the one fact the strip's honesty depends
 * on: whether those bars were MEASURED or SYNTHESIZED.
 *
 * ISS-5566: `buildActivityBuckets` used to return a bare `ActivityBucket[]`, so
 * by the time the strip rendered there was nothing left to distinguish buckets
 * the collector actually persisted from buckets manufactured here out of the
 * transcript's shape — and the renderer painted both as measured dollars. The
 * provenance is a property of the whole strip (either `session.activityBuckets`
 * was there or it was not), so it rides on the result rather than on each
 * bucket; keeping it off `ActivityBucket` also keeps a cross-repo payload type
 * out of a purely local rendering concern.
 */
export type ActivityBucketStrip = {
  buckets: ActivityBucket[];
  /**
   * `true` when the session carried no persisted `activityBuckets` and every
   * dollar on these buckets was manufactured below — the total from
   * {@link MIN_ACTIVITY_COST}-floored `estimatedCost`, the per-bucket share from
   * {@link getFallbackBucketWeight}'s heuristic, and the in/out/cache split from
   * the three fixed ratios. Callers must not render those figures as measured
   * money.
   */
  synthesized: boolean;
};

/**
 * Build the Session Timeline's bars for a session.
 *
 * Two genuinely different paths, and the caller is owed the difference:
 *
 * - MEASURED — the session carries persisted `activityBuckets`, which already
 *   hold real per-model token cost. They pass through `alignBucketRowsToTranscript`
 *   (which only repairs `tl0` jump targets) and are reported `synthesized: false`.
 * - SYNTHESIZED — there are no persisted buckets, so the strip is reconstructed
 *   from the transcript's turn items. The SHAPE is evidence-backed (a bucket's
 *   height tracks how many turns and tool calls landed in its slice), but every
 *   DOLLAR on it is invented, so the result is reported `synthesized: true`.
 */
export function buildActivityBuckets(
  session: AgentSessionDetail,
  markers: ActivityMarker[],
  window: SessionTimelineWindow | null
): ActivityBucketStrip {
  if (session.activityBuckets && session.activityBuckets.length > 0) {
    return {
      buckets: alignBucketRowsToTranscript(
        session.activityBuckets,
        session,
        window
      ),
      synthesized: false,
    };
  }

  const rows = session.turnItems ?? [];
  if (rows.length === 0) {
    /*
     * There is no strip. `synthesized: false` reads "nothing was manufactured",
     * not "these bars were measured" — the caller renders its "no activity
     * recorded" empty state and never reaches the disclosure, so attaching one
     * here would caption an empty strip.
     *
     * Review note (logical-parsing-integrity-auditor): this is a THIRD state
     * ("no data") riding the same boolean as "measured". That is inert only
     * because `buckets` is empty and every consumer must handle the empty strip
     * before it can read the flag. A future consumer that reads `synthesized`
     * WITHOUT first checking `buckets.length` would misread this; pair the two.
     */
    return { buckets: [], synthesized: false };
  }

  const timedRows = rows.filter(hasTimedTraceRow);
  if (timedRows.length === 0) {
    return {
      buckets: buildEvenActivityBuckets(session, rows, markers),
      synthesized: true,
    };
  }

  return {
    buckets: buildTimedActivityBuckets(session, timedRows, window),
    synthesized: true,
  };
}

function buildTimedActivityBuckets(
  session: AgentSessionDetail,
  timedRows: readonly (TurnItem & { _row: number; t: string })[],
  window: SessionTimelineWindow | null
): ActivityBucket[] {
  /*
   * ISS-4821 (wongk review): bucket against the RESOLVED window, not the
   * transcript's own min/max. The bars sit directly under the axis, so building
   * them on a transcript-only scale while the axis is drawn on a window widened
   * by the Activity-phases tiling put the two on different scales — a bar under
   * the 40% tick did not mean 40% of the axis. The transcript bounds remain the
   * fallback for a session with no usable window, which is the prior behavior.
   */
  const rowBounds = getTimedRowBounds(timedRows);
  const firstMs = window ? window.startMs : rowBounds.minMs;
  const lastMs = window ? window.endMs : rowBounds.maxMs;
  const spanMs = Math.max(1, lastMs - firstMs);
  const bucketCount = getFallbackBucketCount(spanMs, timedRows.length);
  const model = session.primaryModel ?? session.model ?? "model";
  const buckets = Array.from(
    { length: bucketCount },
    (_, bucketIndex): ActivityBucket => ({
      key: `time-${bucketIndex}-${Math.round(firstMs + (spanMs * bucketIndex) / bucketCount)}`,
      label: formatBucketLabel(firstMs + (spanMs * bucketIndex) / bucketCount),
      cIn: 0,
      cOut: 0,
      cCache: 0,
      total: 0,
      toolStart: 0,
      tl0: null,
      byModel: {
        [model]: {
          cIn: 0,
          cOut: 0,
          cCache: 0,
        },
      },
      // ISS-5819 review (wongk): this path DOES know its own clock — it bins
      // over `[firstMs, lastMs]` right here — so it states it, on the same
      // optional wire fields the desktop collector fills. `buildEvenActivityBuckets`
      // deliberately does not: those bins are ORDINAL (n rows per bucket, no
      // wall-clock extent), so leaving the fields absent is what keeps that strip
      // off a clock projection it has no basis for.
      binStartMs: firstMs + (spanMs * bucketIndex) / bucketCount,
      binEndMs: firstMs + (spanMs * (bucketIndex + 1)) / bucketCount,
    })
  );

  for (const row of timedRows) {
    const bucket =
      buckets[
        getBucketIndexFromMs(getTurnItemMs(row), firstMs, spanMs, bucketCount)
      ];
    bucket.total += getTurnEventCount(row);
    bucket.toolStart += getTurnToolCallCount(row);
    if (bucket.tl0 == null || row._row < bucket.tl0) {
      bucket.tl0 = row._row;
    }
  }

  const totalWeight = buckets.reduce(
    (sum, bucket) => sum + getFallbackBucketWeight(bucket),
    0
  );
  const totalCost = Math.max(session.estimatedCost, MIN_ACTIVITY_COST);
  for (const bucket of buckets) {
    const weight = getFallbackBucketWeight(bucket);
    if (weight === 0 || totalWeight === 0) {
      continue;
    }
    const bucketCost = totalCost * (weight / totalWeight);
    applyBucketCost(bucket, model, bucketCost);
  }

  return buckets;
}

function buildEvenActivityBuckets(
  session: AgentSessionDetail,
  rows: TurnItem[],
  markers: ActivityMarker[]
): ActivityBucket[] {
  const bucketCount = Math.min(16, Math.max(4, rows.length));
  const bucketSize = Math.ceil(rows.length / bucketCount);
  const cost = Math.max(session.estimatedCost, MIN_ACTIVITY_COST);
  const costPerRow = cost / rows.length;
  const model = session.primaryModel ?? session.model ?? "model";
  return Array.from({ length: bucketCount }, (_, bucketIndex) => {
    const firstIndex = bucketIndex * bucketSize;
    const bucketRows = rows.slice(firstIndex, firstIndex + bucketSize);
    const firstRow = bucketRows.find(hasTraceRow);
    const toolStart = sumOver(bucketRows, getTurnToolCallCount);
    const bucketCost = bucketRows.length * costPerRow;
    const idle = bucketRows.length === 0;
    const bucket: ActivityBucket = {
      key: `even-${bucketIndex}-${firstIndex}`,
      label: firstRow ? formatMarkerTime(firstRow.t) : "",
      cIn: 0,
      cOut: 0,
      cCache: 0,
      total: sumOver(bucketRows, getTurnEventCount),
      toolStart,
      tl0: firstRow?._row ?? markers[bucketIndex]?.tl ?? null,
      byModel: {
        [model]: {
          cIn: 0,
          cOut: 0,
          cCache: 0,
        },
      },
    };
    if (!idle) {
      applyBucketCost(bucket, model, bucketCost);
    }
    return bucket;
  });
}

/**
 * How many raw timeline events one synthesized turn row stands for, and how many
 * of them were tool CALLS.
 *
 * ISS-5566 review: counting rows here counted the wrong population.
 * `buildToolsTurn` (packages/lib/sessions/agent-session-detail-projection.ts)
 * folds a CONSECUTIVE RUN of tool-like timeline events into ONE
 * `type: "tools"` TurnItem carrying `items: ToolItem[]`, so `+= 1` per row
 * counted RUNS. The measured producer counts the other population —
 * apps/desktop/src/main/database/session-trace.ts walks the raw
 * `timelineRows` and does `total += 1` / `toolStart += 1` once per row, i.e.
 * once per CALL.
 *
 * Two things leaned on the mismatch. The SHAPE: with `total + toolStart * 3`
 * as the weight, a bucket holding a single folded run of 12 calls scored
 * `1 + 3 = 4` while three separate single-call runs in the next bucket scored
 * `3 + 9 = 12`, so the taller bar was the one carrying a quarter of the work.
 * The READOUT: with the disclosure on, `{total} events | {toolStart} tool
 * calls` is the only quantitative content left on a synthesized bucket, and it
 * printed a run count under a label that means calls on the measured strip.
 *
 * Unfolding here puts both producers on the same population. The `1` floor
 * keeps a tools turn that somehow folded no items from disappearing from the
 * strip entirely.
 */
function getTurnEventCount(row: TurnItem): number {
  return row.type === "tools" ? Math.max(1, row.items.length) : 1;
}

function getTurnToolCallCount(row: TurnItem): number {
  return row.type === "tools" ? Math.max(1, row.items.length) : 0;
}

function sumOver(
  rows: readonly TurnItem[],
  count: (row: TurnItem) => number
): number {
  return rows.reduce((sum, row) => sum + count(row), 0);
}

function getFallbackBucketCount(spanMs: number, rowCount: number): number {
  if (spanMs >= DAY_MS) {
    return 48;
  }
  if (spanMs >= FOUR_HOURS_MS) {
    return 32;
  }
  return Math.min(16, Math.max(4, rowCount));
}

function formatBucketLabel(value: number): string {
  return formatTime(new Date(value));
}

/**
 * A synthesized bucket's share of the session, in arbitrary units.
 *
 * ISS-5566: the `* 3` is a guess about how much of a turn's spend a tool call
 * represents, and nothing measured backs it. It survives because it drives only
 * the bar's HEIGHT — a relative-activity encoding the strip discloses as such —
 * and never a figure presented to the reader as money.
 */
function getFallbackBucketWeight(bucket: ActivityBucket): number {
  if (bucket.total === 0) {
    return 0;
  }
  return bucket.total + bucket.toolStart * 3;
}

/**
 * Spread one synthesized bucket's share across the in/out/cache channels.
 *
 * ISS-5566: these three ratios are a fixed guess at a token mix, identical on
 * every bucket of every session — the ratio repeating bar after bar is the
 * documented tell that a strip is synthesized. They stay because `getBucketCost`
 * sums the three channels to produce the bar height, so zeroing them here would
 * flatten the strip; the honesty is enforced at the render boundary instead,
 * where a synthesized strip shows no dollar figure at all.
 */
function applyBucketCost(
  bucket: ActivityBucket,
  model: string,
  bucketCost: number
) {
  bucket.cIn = bucketCost * ACTIVITY_COST_INPUT_RATIO;
  bucket.cOut = bucketCost * ACTIVITY_COST_OUTPUT_RATIO;
  bucket.cCache = bucketCost * ACTIVITY_COST_CACHE_RATIO;
  bucket.byModel[model] = {
    cIn: bucket.cIn,
    cOut: bucket.cOut,
    cCache: bucket.cCache,
  };
}

const DAY_MS = 86_400_000;
const FOUR_HOURS_MS = 14_400_000;
const MIN_ACTIVITY_COST = 0.01;
const ACTIVITY_COST_INPUT_RATIO = 0.08;
const ACTIVITY_COST_OUTPUT_RATIO = 0.23;
const ACTIVITY_COST_CACHE_RATIO = 0.69;
