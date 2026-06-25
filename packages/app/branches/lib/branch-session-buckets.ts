import type {
  BranchPageDetail,
  BranchSession,
  MergedTraceItem,
} from "@repo/api/src/types/branch";
import type { BranchActorColorDomain } from "./branch-actor-domain";
import { computeBurstSpans } from "./branch-burst-spans";

/**
 * Session-driven per-hour-by-actor bucketize (Epic E / E1) — the design's
 * `bqBucketize`. Distributes each session's tokens across the clock-hours its
 * ACTIVE bursts span, keyed by the session's actor, so the timeline shows real
 * bars over real work (idle hours stay empty → rendered as gaps) and attributes
 * by actor. v1 reads sessions + the merged trace (which ARE populated) rather
 * than `usage.hourBuckets` (whose owner is null and which is underpopulated in
 * v1), and so it stays consistent with the swimlane (E4) and trace (D2).
 */
const HOUR_MS = 3_600_000;
const UNATTRIBUTED_KEY = "__unattributed__";
// Defensive ceiling on the timeline span. A single malformed or malicious
// far-future `endedAt`/trace timestamp would otherwise drive an effectively
// unbounded hour-by-hour loop (one column allocated per hour), hanging the
// branch detail tab. 90 days of hourly buckets is far beyond any real branch's
// session span while still bounding worst-case work; spans past it are truncated.
const MAX_TIMELINE_HOURS = 24 * 90;
const MAX_TIMELINE_SPAN_MS = MAX_TIMELINE_HOURS * HOUR_MS;

export type TimelineSegment = {
  key: string;
  owner: string | null;
  value: number;
  /** input / output / cache token split (for the per-hour hover breakdown). */
  input: number;
  output: number;
  cache: number;
  color: string;
};

export type TimelineColumn = {
  hourStart: string;
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
};

type OwnerTokens = { input: number; output: number; cache: number };
type HourOwnerTokens = Map<number, Map<string | null, OwnerTokens>>;

function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** A session's actor: captured `sessionstart` name, else harness, else null. */
function resolveOwner(
  captured: string | null | undefined,
  harness: string
): string | null {
  if (captured != null && captured !== "") {
    return captured;
  }
  return harness === "" ? null : harness;
}

/**
 * Spread one session's tokens over the hours its active bursts cover, mutating
 * `acc`. Returns the touched hour range, or null when the session has no burst.
 */
function accumulateSession(
  session: BranchSession,
  owner: string | null,
  items: MergedTraceItem[],
  acc: HourOwnerTokens
): { minHour: number; maxHour: number } | null {
  const input = session.inputTokens;
  const output = session.outputTokens;
  const cache = session.cacheReadTokens + session.cacheWriteTokens;
  // Parse + validate bursts, clamping each span so one bad far-future timestamp
  // can't drive an unbounded hour-by-hour loop (a DoS via untrusted timestamps).
  const spans: { start: number; end: number }[] = [];
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
    spans.push({ start, end: Math.min(rawEnd, start + MAX_TIMELINE_SPAN_MS) });
  }
  if (spans.length === 0) {
    return null;
  }
  const totalActive = Math.max(
    1,
    spans.reduce((sum, span) => sum + (span.end - span.start), 0)
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
      const owners = acc.get(hour) ?? new Map<string | null, OwnerTokens>();
      const cur = owners.get(owner) ?? { input: 0, output: 0, cache: 0 };
      cur.input += input * fraction;
      cur.output += output * fraction;
      cur.cache += cache * fraction;
      owners.set(owner, cur);
      acc.set(hour, owners);
    }
  }
  return { minHour, maxHour };
}

function toColumn(
  hourStart: string,
  owners: Map<string | null, OwnerTokens> | undefined,
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
    .map(([owner, tokens]) => ({
      key: owner ?? UNATTRIBUTED_KEY,
      owner,
      value: tokens.input + tokens.output + tokens.cache,
      input: tokens.input,
      output: tokens.output,
      cache: tokens.cache,
      color: domain.colorFor(owner),
    }))
    .filter((segment) => segment.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return {
    hourStart,
    total,
    segments,
    isGap: total === 0,
    hasConcurrency: segments.length >= 2,
  };
}

export function buildSessionTimeline(
  detail: BranchPageDetail,
  domain: BranchActorColorDomain
): SessionTimeline {
  const actorBySession = new Map<string, string | null>();
  const itemsBySession = new Map<string, MergedTraceItem[]>();
  for (const item of detail.mergedTrace) {
    const list = itemsBySession.get(item.sessionId) ?? [];
    list.push(item);
    itemsBySession.set(item.sessionId, list);
    if (item.type === "sessionstart") {
      actorBySession.set(item.sessionId, item.actor.name);
    }
  }

  const acc: HourOwnerTokens = new Map();
  let minHour = Number.POSITIVE_INFINITY;
  let maxHour = Number.NEGATIVE_INFINITY;
  for (const session of detail.sessions) {
    const owner = resolveOwner(
      actorBySession.get(session.sessionId),
      session.harness
    );
    const span = accumulateSession(
      session,
      owner,
      itemsBySession.get(session.sessionId) ?? [],
      acc
    );
    if (span) {
      minHour = Math.min(minHour, span.minHour);
      maxHour = Math.max(maxHour, span.maxHour);
    }
  }

  if (minHour === Number.POSITIVE_INFINITY) {
    return { columns: [], maxTotal: 0, startMs: null, endMs: null };
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

  return {
    columns,
    maxTotal,
    startMs: minHour,
    endMs: cappedMaxHour + HOUR_MS,
  };
}
