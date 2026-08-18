import type {
  BranchPageDetail,
  BranchSession,
} from "@repo/api/src/types/branch";
import { resolveAttributedBranchCost } from "@repo/api/src/types/branch-cost";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import {
  type BranchActorColorDomain,
  BranchActorTurnSide,
} from "./branch-actor-domain";
import { computeBurstSpans } from "./branch-burst-spans";

/**
 * Session-driven per-hour-by-USER bucketize (Epic E / E1, FEA-3576). Distributes
 * each session's COST across the clock-hours its ACTIVE bursts span, keyed by the
 * HUMAN stakeholder/user who paid for it (`session.ownerUserName`), so the
 * timeline shows real bars over real work (idle hours stay empty → rendered as
 * gaps) and attributes spend BY USER (e.g. Chris's spend vs Thadeus's spend
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
const HOUR_MS = 3_600_000;
const UNATTRIBUTED_KEY = "__unattributed__";
// Defensive ceiling on the timeline span. A single malformed or malicious
// far-future `endedAt`/trace timestamp would otherwise drive an effectively
// unbounded hour-by-hour loop (one column allocated per hour), hanging the
// branch detail tab. 90 days of hourly buckets is far beyond any real branch's
// session span while still bounding worst-case work; spans past it are truncated.
// Exported because the timeline's user-facing truncation disclosure states this
// cap in days — the sentence must be built from the constant, never re-typed.
export const MAX_TIMELINE_DAYS = 90;
const MAX_TIMELINE_HOURS = 24 * MAX_TIMELINE_DAYS;
const MAX_TIMELINE_SPAN_MS = MAX_TIMELINE_HOURS * HOUR_MS;

export type TimelineSegment = {
  key: string;
  /** The human stakeholder/user this segment's spend is attributed to. */
  owner: string | null;
  /** FEA-3576 — the segment SIZE: this user's cost (USD) within the hour. */
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
  startMs: number | null;
  endMs: number | null;
  /**
   * Cost represented by the rendered activity bars. `null` means no loaded
   * Session had both bucketable timing and a defensible cost subtotal.
   */
  chartableCostUsd: number | null;
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

export type TimelineSessionIdentity = Pick<
  BranchSession,
  "name" | "navigableRef" | "sessionId" | "slug"
>;

type OwnerBucket = {
  label: string | null;
  cost: number;
  input: number;
  output: number;
  cache: number;
  costUnavailable: boolean;
  hasKnownCost: boolean;
};
type HourOwnerBucket = Map<number, Map<string, OwnerBucket>>;

function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

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
      (label ? `legacy:${label.toLocaleLowerCase()}` : UNATTRIBUTED_KEY),
    label,
  };
}

/**
 * Spread one session's already-resolved even-split COST (and its token split)
 * over the hours its active bursts cover, mutating `acc`. Returns the touched hour
 * range plus whether any burst exceeded the bounded render span, or null when
 * the session has no burst. `cost` is this branch's share of
 * the session's spend (see `resolveSessionCost`); it is distributed by active-time
 * fraction, the SAME shape the previous token distribution used, so a session that
 * ran across two hours has its spend split between them proportionally to active
 * time. The caller resolves `cost` per session so a session shared across N
 * branches contributes only this branch's 1/N share and the stacked bars sum to
 * the header attributed cost stat exactly.
 */
function accumulateSession(
  session: BranchSession,
  owner: { key: string; label: string | null },
  items: MergedTraceItem[],
  acc: HourOwnerBucket,
  cost: number,
  costUnavailable: boolean
): { minHour: number; maxHour: number; truncated: boolean } | null {
  const input = session.inputTokens;
  const output = session.outputTokens;
  const cache = session.cacheReadTokens + session.cacheWriteTokens;
  // Parse + validate bursts, clamping each span so one bad far-future timestamp
  // can't drive an unbounded hour-by-hour loop (a DoS via untrusted timestamps).
  const spans: { start: number; end: number; rawEnd: number }[] = [];
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
  if (spans.length === 0) {
    return null;
  }
  const totalActive = Math.max(
    1,
    spans.reduce((sum, span) => sum + (span.rawEnd - span.start), 0)
  );

  let minHour = Number.POSITIVE_INFINITY;
  let maxHour = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    minHour = Math.min(minHour, floorHour(span.start));
    maxHour = Math.max(maxHour, floorHour(span.end - 1));
    for (let hour = floorHour(span.start); hour < span.end; hour += HOUR_MS) {
      const overlap =
        Math.min(span.end, hour + HOUR_MS) - Math.max(span.start, hour);
      if (overlap <= 0) {
        continue;
      }
      const fraction = overlap / totalActive;
      const owners = acc.get(hour) ?? new Map<string, OwnerBucket>();
      const cur = owners.get(owner.key) ?? {
        label: owner.label,
        cost: 0,
        input: 0,
        output: 0,
        cache: 0,
        costUnavailable: false,
        hasKnownCost: false,
      };
      cur.cost += cost * fraction;
      cur.input += input * fraction;
      cur.output += output * fraction;
      cur.cache += cache * fraction;
      cur.costUnavailable ||= costUnavailable;
      cur.hasKnownCost ||= !costUnavailable;
      owners.set(owner.key, cur);
      acc.set(hour, owners);
    }
  }
  return {
    minHour,
    maxHour,
    truncated: spans.some((span) => span.rawEnd > span.end),
  };
}

function toColumn(
  hourStart: string,
  owners: Map<string, OwnerBucket> | undefined,
  domain: BranchActorColorDomain
): TimelineColumn {
  if (!owners || owners.size === 0) {
    return {
      hourStart,
      total: 0,
      segments: [],
      isGap: true,
      hasConcurrency: false,
    };
  }
  const segments = [...owners.entries()]
    .map(([key, bucket]) => ({
      key,
      owner: bucket.label,
      value: bucket.cost,
      input: bucket.input,
      output: bucket.output,
      cache: bucket.cache,
      color: domain.colorForTurn(bucket.label, BranchActorTurnSide.Human, key),
      costUnavailable: bucket.costUnavailable,
      hasKnownCost: bucket.hasKnownCost,
    }))
    .sort((a, b) => b.value - a.value);
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

/**
 * Dedup a branch's session rows by session id, first-seen wins. The same session
 * artifact is pushed onto a branch's `sessions` once per link, so a branch can
 * carry DUPLICATE rows for one session. Both the cost divisor AND the cost/token
 * accumulation must run over the SAME deduped set, or a duplicated session's spend
 * is counted multiple times in the bars while the divisor counts it once — the
 * classic double-count on aggregation. Every duplicate row carries identical
 * session-level cost/tokens, so first-seen is lossless.
 */
function distinctSessions(sessions: readonly BranchSession[]): BranchSession[] {
  const seen = new Set<string>();
  const distinct: BranchSession[] = [];
  for (const session of sessions) {
    if (seen.has(session.sessionId)) {
      continue;
    }
    seen.add(session.sessionId);
    distinct.push(session);
  }
  return distinct;
}

/**
 * The fallback factor that maps each session's captured (full) cost onto this
 * branch's even-split share when the server did NOT stamp per-session even-split
 * costs (`evenSplitCostUsd`) — older/wire producers, or the single-player desktop
 * store. It is `branchEvenSplitTotal / Σ distinct session cost`, a single
 * branch-wide ratio. This is EXACT only when every session has the same branch
 * count (e.g. all single-branch: scale ≡ 1); when the producer stamps
 * `evenSplitCostUsd`, the per-session path below is used instead so bars reconcile
 * exactly even with mixed branch counts. Returns 1 (no scaling) when the branch
 * has no priced even-split total or when the raw session-cost sum is 0
 * (divide-by-zero guard). `sessions` MUST already be deduped by id.
 */
function computeFallbackCostScale(
  detail: BranchPageDetail,
  sessions: readonly BranchSession[]
): number {
  const branchTotal = resolveAttributedBranchCost(detail);
  if (branchTotal == null || branchTotal < 0) {
    return 1;
  }
  let rawTotal = 0;
  for (const session of sessions) {
    rawTotal += session.estimatedCostUsd ?? 0;
  }
  return rawTotal > 0 ? branchTotal / rawTotal : 1;
}

/**
 * This branch's even-split share of one session's spend. Prefers the server's
 * authoritative per-session `evenSplitCostUsd` (full cost ÷ the session's OWN
 * global branch count) — the SAME per-session division the server's
 * `evenSplitBranchCost` sums, so the bars reconcile with the header cost stat to
 * the cent even when sessions have DIFFERENT branch counts. Falls back to the full
 * captured cost times the branch-wide `fallbackScale` when the producer did not
 * stamp per-session shares (older/wire producers, single-player desktop — where
 * every branch count is 1 and the uniform scale is exact).
 */
function resolveSessionCost(
  session: BranchSession,
  fallbackScale: number,
  branchCostUnavailable: boolean
): number {
  if (branchCostUnavailable) {
    return 0;
  }
  if (session.evenSplitCostUsd != null) {
    return session.evenSplitCostUsd;
  }
  return (session.estimatedCostUsd ?? 0) * fallbackScale;
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
  detail: BranchPageDetail,
  domain: BranchActorColorDomain
): SessionTimeline {
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
  const sessions = distinctSessions(detail.sessions);
  const distinctSessionCount = sessions.length;

  // Reconcile the bars' total with the branch's even-split cost stat. Prefer the
  // server's per-session even-split shares (`evenSplitCostUsd`, full cost ÷ that
  // session's OWN branch count) so a session shared across N branches contributes
  // only this branch's 1/N share and the stacked bars sum to the same
  // canonical attributed total the card shows — exactly, even with mixed branch
  // counts. When the producer did not stamp per-session shares, fall back to a
  // single branch-wide scale (exact for the single-branch/desktop case).
  const fallbackScale = computeFallbackCostScale(detail, sessions);
  // A supplied null is authoritative and must not resurrect raw Session costs.
  // Omission remains the version-skew path: legacy producers can still expose a
  // defensible rendered Session subtotal when their top-level raw total is null.
  const branchCostUnavailable = detail.attributedCostUsd === null;

  const acc: HourOwnerBucket = new Map();
  let minHour = Number.POSITIVE_INFINITY;
  let maxHour = Number.NEGATIVE_INFINITY;
  const nonBucketableSessions: TimelineSessionIdentity[] = [];
  const bucketableSessionSpans: Array<{
    identity: TimelineSessionIdentity;
    maxHour: number;
    truncated: boolean;
  }> = [];
  for (const session of sessions) {
    const owner = resolveOwner(session);
    const span = accumulateSession(
      session,
      owner,
      itemsBySession.get(session.sessionId) ?? [],
      acc,
      resolveSessionCost(session, fallbackScale, branchCostUnavailable),
      isSessionCostUnavailable(session, branchCostUnavailable)
    );
    if (span) {
      minHour = Math.min(minHour, span.minHour);
      maxHour = Math.max(maxHour, span.maxHour);
      bucketableSessionSpans.push({
        identity: toTimelineSessionIdentity(session),
        maxHour: span.maxHour,
        truncated: span.truncated,
      });
    } else {
      nonBucketableSessions.push(toTimelineSessionIdentity(session));
    }
  }

  if (minHour === Number.POSITIVE_INFINITY) {
    return {
      columns: [],
      maxTotal: 0,
      startMs: null,
      endMs: null,
      chartableCostUsd: null,
      nonBucketableSessions,
      truncatedSessions: [],
      distinctSessionCount,
    };
  }

  // Cap the rendered span so far-apart sessions (or a clamped outlier) can't
  // allocate an unbounded number of hourly columns.
  const cappedMaxHour = Math.min(
    maxHour,
    minHour + MAX_TIMELINE_SPAN_MS - HOUR_MS
  );
  const columns: TimelineColumn[] = [];
  let maxTotal = 0;
  for (let hour = minHour; hour <= cappedMaxHour; hour += HOUR_MS) {
    const column = toColumn(
      new Date(hour).toISOString(),
      acc.get(hour),
      domain
    );
    maxTotal = Math.max(maxTotal, column.total);
    columns.push(column);
  }
  const renderedSegments = columns.flatMap((column) => column.segments);
  const hasChartableCost = renderedSegments.some(
    (segment) => segment.hasKnownCost
  );
  const chartableCostUsd = renderedSegments.reduce(
    (total, segment) => total + segment.value,
    0
  );
  const truncatedSessions = bucketableSessionSpans.flatMap((session) =>
    session.truncated || session.maxHour > cappedMaxHour
      ? [session.identity]
      : []
  );

  return {
    columns,
    maxTotal,
    startMs: minHour,
    endMs: cappedMaxHour + HOUR_MS,
    chartableCostUsd: hasChartableCost ? chartableCostUsd : null,
    nonBucketableSessions,
    truncatedSessions,
    distinctSessionCount,
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
