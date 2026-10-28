import type { BranchSession } from "@repo/api/src/types/branch";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import type { SessionTimelineDetail } from "@repo/api/src/types/document-sessions";
import {
  clampTimelineWindowStart,
  resolveTimelineColumnIndex,
  resolveTimelineScaleGeometry,
  TIMELINE_VISIBLE_COLUMNS,
  TimelineScale,
  type TimelineScaleGeometry,
  type TimelineScale as TimelineScaleType,
  timelineColumnStartMs,
} from "@repo/app/agents/lib/session-timeline-scale";
import { ActorTurnSide } from "@repo/app/shared/lib/actor-color-domain";
import type { BranchActorColorDomain } from "./branch-actor-domain";
import { computeBurstSpans } from "./branch-burst-spans";
import {
  distinctBranchSessions,
  resolveBranchSessionCost,
  resolveBranchSessionFallbackCostScale,
} from "./branch-session-cost";
import { phaseAllocationsForWindow } from "./branch-timeline-phase-allocation";

/**
 * Session-driven per-hour-by-USER bucketize (Epic E / E1, FEA-3576). Distributes
 * each session's COST across the clock-hours its ACTIVE bursts span, keyed by the
 * HUMAN stakeholder/user who paid for it (`session.ownerUserName`), so the
 * timeline shows real bars over real work (idle hours stay empty → rendered as
 * gaps) and attributes spend BY USER (e.g. Cosimo's spend vs Tamsin's spend
 * within each hour). v1 reads sessions + the merged trace (which ARE populated)
 * rather than `usage.hourBuckets` (whose owner is null and which is
 * underpopulated in v1), and so it stays consistent with the swimlane (E4) and
 * trace (D2).
 *
 * Before FEA-3576 this segmented by the session/model ACTOR and sized by token
 * count; the design intends per-user COST. The token input/output/cache split is
 * still carried per segment (spread by the same active-time fraction) so the
 * hover card keeps its usage breakdown, but the segmentation dimension and
 * segment size are now the user and their cost.
 */
const MS_PER_MINUTE = 60_000;
// Defensive ceiling on the timeline span. A single malformed or malicious
// far-future `endedAt`/trace timestamp would otherwise drive an effectively
// unbounded hour-by-hour loop (one column allocated per hour), hanging the
// branch detail tab. 90 days of hourly buckets is far beyond any real branch's
// session span while still bounding worst-case work; spans past it are truncated.
// Exported because the timeline's user-facing truncation disclosure states this
// cap in days — the sentence must be built from the constant, never re-typed.
export const MAX_TIMELINE_DAYS = 90;
const MAX_TIMELINE_SPAN_MS = MAX_TIMELINE_DAYS * 24 * 60 * MS_PER_MINUTE;
const OWNER_UNATTRIBUTED_KEY = "__unattributed__";

export const BranchTimelineGrouping = {
  SessionOwner: "session-owner",
  ActivityPhase: "activity-phase",
} as const;
export type BranchTimelineGrouping =
  (typeof BranchTimelineGrouping)[keyof typeof BranchTimelineGrouping];

export const DEFAULT_BRANCH_TIMELINE_GROUPING =
  BranchTimelineGrouping.SessionOwner;

export const BRANCH_TIMELINE_GROUPING_OPTIONS: readonly {
  readonly label: string;
  readonly value: BranchTimelineGrouping;
}[] = [
  { label: "Session owner", value: BranchTimelineGrouping.SessionOwner },
  { label: "Activity phase", value: BranchTimelineGrouping.ActivityPhase },
];

export type TimelineSegment = {
  key: string;
  /** Display label resolved from the selected grouping dimension. */
  label: string;
  /** Human owner for owner grouping; null for non-owner grouping dimensions. */
  owner: string | null;
  /** FEA-3576 — the segment SIZE: this bucket's cost (USD) within the hour. */
  value: number;
  /** input / output / cache token split (for the per-hour hover breakdown). */
  input: number;
  output: number;
  cache: number;
  color: string;
  /** True when activity is known but no defensible cost value was available. */
  costUnavailable: boolean;
  /** True when at least one merged activity contribution has a known cost. */
  hasKnownCost: boolean;
};

export type TimelineColumn = {
  hourStart: string;
  /** FEA-3576 — total COST (USD) across the hour's user segments. */
  total: number;
  segments: TimelineSegment[];
  isGap: boolean;
  hasConcurrency: boolean;
};

export type SessionTimeline = {
  columns: TimelineColumn[];
  maxTotal: number;
  /** Start of the visible activity window. */
  startMs: number | null;
  /** End of the visible activity window. */
  endMs: number | null;
  /** Start of the full chartable activity span before panning. */
  fullStartMs: number | null;
  /** End of the full chartable activity span before panning. */
  fullEndMs: number | null;
  /** Width of each rendered timeline column. */
  columnMs: number;
  /** Current visible window start, in absolute columns from the full span. */
  windowStart: number;
  /** Largest legal window start for the selected scale. */
  maxWindowStart: number;
  /** Total columns in the full chartable span. */
  totalColumns: number;
  /**
   * Cost represented by the rendered activity bars. `null` means no loaded
   * Session had both bucketable timing and a defensible cost subtotal.
   */
  chartableCostUsd: number | null;
  /**
   * ISS-12665: the costliest column across EVERY column at this scale, not the
   * visible window, so it holds still while the scrubber pans. `null` exactly
   * when {@link chartableCostUsd} is — no bar carries a known cost.
   */
  peakColumnCostUsd: number | null;
  /** Loaded Sessions whose timing could not produce a positive-duration bar. */
  nonBucketableSessions: TimelineSessionIdentity[];
  /** Bucketable Sessions whose activity extends beyond the rendered span cap. */
  truncatedSessions: TimelineSessionIdentity[];
  /**
   * Count of DISTINCT sessions (deduped by `sessionId`, the same key the bars use)
   * that fed this timeline. A branch can carry duplicate session rows (one per PR
   * link), so this — not `detail.sessions.length` — is the count any "N sessions"
   * messaging must show, or a session repeated across two links reads as 2.
   */
  distinctSessionCount: number;
};

/**
 * ISS-8771 — the window is the canonical one or it is nothing.
 *
 * There is deliberately no `visibleColumns`: the width of a trace window is
 * {@link TIMELINE_VISIBLE_COLUMNS}, owned by `session-timeline-scale`, and a
 * per-call override here was a second answer to a question that already had
 * one.
 */
export type BranchTimelineWindowOptions = {
  readonly scale?: TimelineScaleType;
  readonly windowStart?: number;
};

export type TimelineSessionIdentity = Pick<
  BranchSession,
  "name" | "navigableRef" | "sessionId" | "slug"
>;

type TimelineBucket = {
  label: string;
  owner: string | null;
  cost: number;
  input: number;
  output: number;
  cache: number;
  color: string;
  costUnavailable: boolean;
  hasKnownCost: boolean;
  sortRank: number;
};
/** Contributions keyed by their COLUMN INDEX on the canonical grid. */
type ColumnTimelineBucket = Map<number, Map<string, TimelineBucket>>;

type ActiveSpan = {
  start: number;
  end: number;
  rawEnd: number;
};

type SessionContribution = {
  cache: number;
  cost: number;
  costUnavailable: boolean;
  input: number;
  output: number;
};

type ResolvedTimelineWindow = {
  columns: TimelineColumn[];
  endMs: number | null;
  maxTotal: number;
  maxWindowStart: number;
  startMs: number | null;
  totalColumns: number;
  windowStart: number;
};

/**
 * A session's HUMAN owner (FEA-3576): the resolved stakeholder/user name, or null
 * when no owner is attributable (→ the shared "unattributed" bucket). Empty
 * strings coalesce to null so a blank name never mints a distinct segment.
 */
function resolveOwner(session: BranchSession): {
  key: string;
  label: string | null;
} {
  const name = session.ownerUserName;
  const label = name == null || name === "" ? null : name;
  return {
    key:
      session.ownerUserId?.trim() ||
      (label ? `legacy:${label.toLocaleLowerCase()}` : OWNER_UNATTRIBUTED_KEY),
    label,
  };
}

/**
 * One session's ACTIVE bursts as instants, or an empty list when none parse.
 *
 * Each span is clamped to {@link MAX_TIMELINE_SPAN_MS} so one bad far-future
 * timestamp cannot drive an unbounded column walk (a DoS via untrusted
 * timestamps); `rawEnd` is retained so the caller can still say the span WAS
 * truncated rather than silently rendering the clamp as the real end.
 *
 * Resolved BEFORE any grid exists, because the grid's origin is the earliest of
 * these instants — the two cannot be computed in one pass.
 */
function resolveActiveSpans(
  session: BranchSession,
  items: MergedTraceItem[]
): ActiveSpan[] {
  const spans: ActiveSpan[] = [];
  for (const burst of computeBurstSpans({
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    items,
  })) {
    const start = Date.parse(burst.startT);
    const rawEnd = Date.parse(burst.endT);
    if (Number.isNaN(start) || Number.isNaN(rawEnd) || rawEnd <= start) {
      continue;
    }
    spans.push({
      start,
      end: Math.min(rawEnd, start + MAX_TIMELINE_SPAN_MS),
      rawEnd,
    });
  }
  return spans;
}

/**
 * Spread one session's already-resolved even-split COST (and its token split)
 * over the COLUMNS its active bursts cover, mutating `acc`. Returns the last
 * column index the session reached plus whether any burst exceeded the bounded
 * render span. `cost` is this branch's share of the session's spend (see
 * `resolveSessionCost`); it is distributed by active-time fraction, the SAME
 * shape the previous token distribution used, so a session that ran across two
 * columns has its spend split between them proportionally to active time. The
 * caller resolves `cost` per session so a session shared across N branches
 * contributes only this branch's 1/N share and the stacked bars sum to the
 * header attributed cost stat exactly.
 *
 * ISS-8771: a column's identity and its bounds are asked of the canonical
 * `session-timeline-scale` grid, never re-derived here. The `Math.floor(ms /
 * columnMs)` this replaced is UTC flooring wearing a disguise — the epoch's own
 * zero is UTC midnight — so a `12h` column started at UTC midnight while
 * `formatClock` labelled it on the viewer's clock, and a fixed `+= columnMs`
 * step walked straight through a DST transition the label had already crossed.
 */
function accumulateSession({
  acc,
  cost,
  costUnavailable,
  domain,
  geometry,
  grouping,
  owner,
  scale,
  session,
  spans,
  totalColumns,
}: {
  acc: ColumnTimelineBucket;
  cost: number;
  costUnavailable: boolean;
  domain: BranchActorColorDomain;
  geometry: TimelineScaleGeometry;
  grouping: BranchTimelineGrouping;
  owner: { key: string; label: string | null };
  scale: TimelineScaleType;
  session: BranchSession;
  spans: readonly ActiveSpan[];
  totalColumns: number;
}): { maxColumn: number; truncated: boolean } {
  const input = session.inputTokens;
  const output = session.outputTokens;
  const cache = session.cacheReadTokens + session.cacheWriteTokens;
  const totalActive = Math.max(
    1,
    spans.reduce((sum, span) => sum + (span.rawEnd - span.start), 0)
  );
  const columnStartMs = (columnIndex: number) =>
    timelineColumnStartMs({ columnIndex, originMs: geometry.originMs, scale });

  let maxColumn = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    const firstColumn = resolveTimelineColumnIndex({
      instantMs: span.start,
      originMs: geometry.originMs,
      scale,
    });
    maxColumn = Math.max(
      maxColumn,
      resolveTimelineColumnIndex({
        instantMs: span.end - 1,
        originMs: geometry.originMs,
        scale,
      })
    );
    for (let column = firstColumn; column < totalColumns; column += 1) {
      const startMs = columnStartMs(column);
      if (startMs >= span.end) {
        break;
      }
      const endMs = columnStartMs(column + 1);
      const overlap = Math.min(span.end, endMs) - Math.max(span.start, startMs);
      if (overlap <= 0) {
        continue;
      }
      const fraction = overlap / totalActive;
      const buckets = acc.get(column) ?? new Map<string, TimelineBucket>();
      addTimelineContribution({
        buckets,
        contribution: {
          cost: cost * fraction,
          input: input * fraction,
          output: output * fraction,
          cache: cache * fraction,
          costUnavailable,
        },
        domain,
        grouping,
        owner,
        session,
        windowEnd: Math.min(span.end, endMs),
        windowStart: Math.max(span.start, startMs),
      });
      acc.set(column, buckets);
    }
  }
  return {
    maxColumn,
    truncated: spans.some((span) => span.rawEnd > span.end),
  };
}

function toColumn(
  hourStart: string,
  buckets: Map<string, TimelineBucket> | undefined
): TimelineColumn {
  if (!buckets || buckets.size === 0) {
    return {
      hourStart,
      total: 0,
      segments: [],
      isGap: true,
      hasConcurrency: false,
    };
  }
  const segments = [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      owner: bucket.owner,
      value: bucket.cost,
      input: bucket.input,
      output: bucket.output,
      cache: bucket.cache,
      color: bucket.color,
      costUnavailable: bucket.costUnavailable,
      hasKnownCost: bucket.hasKnownCost,
      sortRank: bucket.sortRank,
    }))
    .sort((a, b) => {
      const byRank = a.sortRank - b.sortRank;
      if (byRank !== 0) {
        return byRank;
      }
      const byCost = b.value - a.value;
      if (byCost !== 0) {
        return byCost;
      }
      return a.label.localeCompare(b.label);
    })
    .map(({ sortRank: _sortRank, ...segment }) => segment);
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return {
    hourStart,
    total,
    segments,
    // Activity is not idle merely because its cost is zero or unavailable.
    // DETAIL-010 requires the trace playhead and timeline to share this exact
    // activity evidence, so only an ownerless hour is a gap.
    isGap: false,
    hasConcurrency: segments.length >= 2,
  };
}

function isSessionCostUnavailable(
  session: BranchSession,
  branchCostUnavailable: boolean
): boolean {
  return (
    branchCostUnavailable ||
    (session.evenSplitCostUsd == null && session.estimatedCostUsd == null)
  );
}

export function buildSessionTimeline(
  detail: SessionTimelineDetail,
  domain: BranchActorColorDomain,
  grouping: BranchTimelineGrouping = DEFAULT_BRANCH_TIMELINE_GROUPING,
  options: BranchTimelineWindowOptions = {}
): SessionTimeline {
  const scale = options.scale ?? TimelineScale.OneHour;
  const itemsBySession = new Map<string, MergedTraceItem[]>();
  for (const item of detail.mergedTrace) {
    const list = itemsBySession.get(item.sessionId) ?? [];
    list.push(item);
    itemsBySession.set(item.sessionId, list);
  }

  // Dedup the session rows ONCE up front so the cost divisor and the cost/token
  // accumulation run over the SAME set — a branch can carry duplicate rows for one
  // session (one per link), and counting a duplicate's spend more than once (while
  // the divisor counts it once) over-attributes the bars. Both the fallback-scale
  // denominator below and the accumulation loop use this deduped list.
  const sessions = distinctBranchSessions(detail.sessions);
  const distinctSessionCount = sessions.length;

  // Reconcile the bars' total with the branch's even-split cost stat. Prefer the
  // server's per-session even-split shares (`evenSplitCostUsd`, full cost ÷ that
  // session's OWN branch count) so a session shared across N branches contributes
  // only this branch's 1/N share and the stacked bars sum to the same
  // canonical attributed total the card shows — exactly, even with mixed branch
  // counts. When some rows have no per-session share, scale only the unstamped
  // residual so stamped rows do not contaminate the fallback ratio.
  const fallbackScale = resolveBranchSessionFallbackCostScale(detail, sessions);
  // A supplied null is authoritative and must not resurrect raw Session costs.
  // Omission remains the version-skew path: legacy producers can still expose a
  // defensible rendered Session subtotal when their top-level raw total is null.
  const branchCostUnavailable = detail.attributedCostUsd === null;

  /*
   * TWO PASSES, and the split is load-bearing (ISS-8771). The canonical grid's
   * origin is the earliest active instant floored to a clock boundary, so the
   * spans have to be resolved before any column exists; the previous single
   * pass could only avoid that by flooring each instant against the epoch,
   * which is the UTC grid this migration removes.
   */
  const bucketable: Array<{ session: BranchSession; spans: ActiveSpan[] }> = [];
  const nonBucketableSessions: TimelineSessionIdentity[] = [];
  let extentStartMs = Number.POSITIVE_INFINITY;
  let extentEndMs = Number.NEGATIVE_INFINITY;
  for (const session of sessions) {
    const spans = resolveActiveSpans(
      session,
      itemsBySession.get(session.sessionId) ?? []
    );
    if (spans.length === 0) {
      nonBucketableSessions.push(toTimelineSessionIdentity(session));
      continue;
    }
    bucketable.push({ session, spans });
    for (const span of spans) {
      extentStartMs = Math.min(extentStartMs, span.start);
      extentEndMs = Math.max(extentEndMs, span.end);
    }
  }

  if (bucketable.length === 0) {
    return emptySessionTimeline({
      columnMs: resolveTimelineScaleGeometry({ endMs: 0, scale, startMs: 0 })
        .columnMs,
      distinctSessionCount,
      nonBucketableSessions,
    });
  }

  const geometry = resolveTimelineScaleGeometry({
    endMs: extentEndMs,
    scale,
    startMs: extentStartMs,
  });
  // Cap the rendered span so far-apart sessions (or a clamped outlier) can't
  // allocate an unbounded number of columns.
  const totalColumns = Math.min(
    geometry.totalColumns,
    maxCanonicalColumns(geometry.originMs, scale)
  );

  const acc: ColumnTimelineBucket = new Map();
  const bucketableSessionSpans = bucketable.map(({ session, spans }) => ({
    identity: toTimelineSessionIdentity(session),
    ...accumulateSession({
      acc,
      cost: resolveBranchSessionCost(
        session,
        fallbackScale,
        branchCostUnavailable
      ),
      costUnavailable: isSessionCostUnavailable(session, branchCostUnavailable),
      domain,
      geometry,
      grouping,
      owner: resolveOwner(session),
      scale,
      session,
      spans,
      totalColumns,
    }),
  }));

  const allColumns = Array.from({ length: totalColumns }, (_, column) =>
    toColumn(
      new Date(
        timelineColumnStartMs({
          columnIndex: column,
          originMs: geometry.originMs,
          scale,
        })
      ).toISOString(),
      acc.get(column)
    )
  );
  /*
   * Read off EVERY column, never the visible window. This is what keeps the
   * headline figure a statement about the whole branch while the scrubber pans
   * a 24-column viewport across it — a subtotal taken from the window would
   * shrink as the reader scrolled.
   */
  const renderedSegments = allColumns.flatMap((column) => column.segments);
  const hasChartableCost = renderedSegments.some(
    (segment) => segment.hasKnownCost
  );
  const chartableCostUsd = renderedSegments.reduce(
    (total, segment) => total + segment.value,
    0
  );
  const truncatedSessions = bucketableSessionSpans.flatMap((session) =>
    session.truncated || session.maxColumn > totalColumns - 1
      ? [session.identity]
      : []
  );
  const visibleWindow = resolveTimelineWindow({
    allColumns,
    geometry,
    scale,
    totalColumns,
    windowStart: options.windowStart ?? 0,
  });

  return {
    columns: visibleWindow.columns,
    maxTotal: visibleWindow.maxTotal,
    startMs: visibleWindow.startMs,
    endMs: visibleWindow.endMs,
    fullStartMs: geometry.originMs,
    fullEndMs: timelineColumnStartMs({
      columnIndex: totalColumns,
      originMs: geometry.originMs,
      scale,
    }),
    columnMs: geometry.columnMs,
    windowStart: visibleWindow.windowStart,
    maxWindowStart: visibleWindow.maxWindowStart,
    totalColumns: visibleWindow.totalColumns,
    chartableCostUsd: hasChartableCost ? chartableCostUsd : null,
    peakColumnCostUsd: hasChartableCost
      ? resolvePeakColumnTotal(allColumns)
      : null,
    nonBucketableSessions,
    truncatedSessions,
    distinctSessionCount,
  };
}

function emptySessionTimeline({
  columnMs,
  distinctSessionCount,
  nonBucketableSessions,
}: {
  columnMs: number;
  distinctSessionCount: number;
  nonBucketableSessions: TimelineSessionIdentity[];
}): SessionTimeline {
  return {
    columns: [],
    maxTotal: 0,
    startMs: null,
    endMs: null,
    fullStartMs: null,
    fullEndMs: null,
    columnMs,
    windowStart: 0,
    maxWindowStart: 0,
    totalColumns: 0,
    chartableCostUsd: null,
    peakColumnCostUsd: null,
    nonBucketableSessions,
    truncatedSessions: [],
    distinctSessionCount,
  };
}

/**
 * The visible window: {@link TIMELINE_VISIBLE_COLUMNS} columns at every scale,
 * panned by `windowStart`, on the canonical grid.
 *
 * Both edges are asked of {@link timelineColumnStartMs} rather than derived as
 * `start + n x columnMs`, because a `12h` column holding a DST transition is
 * genuinely 11 or 13 hours wide and the multiplied end names an instant the
 * bars are not drawn to.
 */
function resolveTimelineWindow({
  allColumns,
  geometry,
  scale,
  totalColumns,
  windowStart,
}: {
  allColumns: readonly TimelineColumn[];
  geometry: TimelineScaleGeometry;
  scale: TimelineScaleType;
  totalColumns: number;
  windowStart: number;
}): ResolvedTimelineWindow {
  const maxWindowStart = Math.max(0, totalColumns - TIMELINE_VISIBLE_COLUMNS);
  const start = clampTimelineWindowStart(windowStart, maxWindowStart);
  const columns = allColumns.slice(start, start + TIMELINE_VISIBLE_COLUMNS);
  const columnStartMs = (columnIndex: number) =>
    timelineColumnStartMs({ columnIndex, originMs: geometry.originMs, scale });
  return {
    columns: [...columns],
    endMs: columns.length === 0 ? null : columnStartMs(start + columns.length),
    maxTotal: columns.reduce(
      (total, column) => Math.max(total, column.total),
      0
    ),
    maxWindowStart,
    startMs: columns.length === 0 ? null : columnStartMs(start),
    totalColumns,
    windowStart: start,
  };
}

function toTimelineSessionIdentity(
  session: BranchSession
): TimelineSessionIdentity {
  return {
    name: session.name,
    navigableRef: session.navigableRef,
    sessionId: session.sessionId,
    slug: session.slug,
  };
}

function addTimelineContribution({
  buckets,
  contribution,
  domain,
  grouping,
  owner,
  session,
  windowEnd,
  windowStart,
}: {
  buckets: Map<string, TimelineBucket>;
  contribution: SessionContribution;
  domain: BranchActorColorDomain;
  grouping: BranchTimelineGrouping;
  owner: { key: string; label: string | null };
  session: BranchSession;
  windowEnd: number;
  windowStart: number;
}): void {
  if (grouping === BranchTimelineGrouping.ActivityPhase) {
    for (const allocation of phaseAllocationsForWindow(
      session.activitySegments,
      windowStart,
      windowEnd
    )) {
      const phaseContribution = {
        cache: contribution.cache * allocation.cacheWeight,
        cost: contribution.cost * allocation.costWeight,
        costUnavailable: contribution.costUnavailable,
        input: contribution.input * allocation.inputWeight,
        output: contribution.output * allocation.outputWeight,
      };
      if (
        hasPositiveContribution(contribution) &&
        !hasPositiveContribution(phaseContribution) &&
        !phaseContribution.costUnavailable
      ) {
        continue;
      }
      mergeContribution(buckets, allocation.key, allocation, phaseContribution);
    }
    return;
  }

  const label = domain.labelFor(owner.label);
  mergeContribution(
    buckets,
    owner.key,
    {
      color: domain.colorForTurn(owner.label, ActorTurnSide.Human, owner.key),
      label,
      owner: owner.label,
      sortRank: 0,
    },
    contribution
  );
}

function mergeContribution(
  buckets: Map<string, TimelineBucket>,
  key: string,
  descriptor: {
    color: string;
    label: string;
    owner?: string | null;
    sortRank: number;
  },
  contribution: SessionContribution
): void {
  const cur = buckets.get(key) ?? {
    cache: 0,
    color: descriptor.color,
    cost: 0,
    costUnavailable: false,
    hasKnownCost: false,
    input: 0,
    label: descriptor.label,
    owner: descriptor.owner ?? null,
    output: 0,
    sortRank: descriptor.sortRank,
  };
  cur.cost += contribution.cost;
  cur.input += contribution.input;
  cur.output += contribution.output;
  cur.cache += contribution.cache;
  cur.costUnavailable ||= contribution.costUnavailable;
  cur.hasKnownCost ||= !contribution.costUnavailable;
  buckets.set(key, cur);
}

function hasPositiveContribution(contribution: SessionContribution): boolean {
  return (
    contribution.cache > 0 ||
    contribution.cost > 0 ||
    contribution.input > 0 ||
    contribution.output > 0
  );
}

/**
 * The column count {@link MAX_TIMELINE_SPAN_MS} of REAL time buys, asked of the
 * canonical grid rather than divided out of a nominal `columnMs`.
 *
 * `Math.floor(MAX_TIMELINE_SPAN_MS / columnMs)` — the arithmetic this replaced —
 * assumes every column is `columnMs` wide, which is the fixed-width assumption
 * ISS-8771 removed everywhere else: a `12h` column is a local HALF-DAY, so a
 * span crossing spring-forward covers one fewer real hour per transition. The
 * division therefore came up one column short of the cap it names, and a run of
 * exactly the capped length lost its final column and was reported truncated at
 * precisely the span the disclosure says fits (#6566 review, whitlockk).
 *
 * `originMs` is already on a column boundary, so the geometry's own floor is a
 * no-op and the count is the grid's answer for this scale, this zone, and the
 * transitions this particular span actually crosses.
 */
function maxCanonicalColumns(
  originMs: number,
  scale: TimelineScaleType
): number {
  // `resolveTimelineScaleGeometry` already floors `totalColumns` at 1.
  return resolveTimelineScaleGeometry({
    endMs: originMs + MAX_TIMELINE_SPAN_MS,
    scale,
    startMs: originMs,
  }).totalColumns;
}

/**
 * ISS-12665: the costliest column's total, or `null` when any column's total is
 * corrupt (non-finite or negative) — a dash rather than `$NaN`, matching the
 * Session Timeline's `resolveTimelinePeakColumnCost`.
 */
function resolvePeakColumnTotal(
  columns: readonly TimelineColumn[]
): number | null {
  let peak = 0;
  for (const column of columns) {
    if (!Number.isFinite(column.total) || column.total < 0) {
      return null;
    }
    peak = Math.max(peak, column.total);
  }
  return peak;
}
