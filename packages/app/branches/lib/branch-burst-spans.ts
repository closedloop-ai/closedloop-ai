import type { MergedTraceItem } from "@repo/api/src/types/branch";
import { activeIdleSpans } from "./branch-derivations";

/**
 * Active-burst spans for one session's lane (Epic E / E4). `activeIdleSpans`
 * returns IDLE spans, so the active bursts are their complement within the
 * session's `[startedAt..end]` window. The first burst after each idle span is a
 * resumption. Degrades to a single full-window burst when there are no idle
 * markers (the v1 capture-side soft dep).
 */
export type BurstSpan = { startT: string; endT: string; isResumption: boolean };

function maxItemMs(items: readonly MergedTraceItem[]): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if ("t" in item && typeof item.t === "string") {
      const ms = Date.parse(item.t);
      if (!Number.isNaN(ms)) {
        max = Math.max(max, ms);
      }
    }
  }
  return max;
}

export function computeBurstSpans(args: {
  startedAt: string;
  endedAt: string | null;
  items: MergedTraceItem[];
  idleThresholdMs?: number;
}): BurstSpan[] {
  const startMs = Date.parse(args.startedAt);
  if (Number.isNaN(startMs)) {
    return [];
  }

  const { idleSpans } = activeIdleSpans(
    args.items,
    args.idleThresholdMs == null
      ? undefined
      : { idleThresholdMs: args.idleThresholdMs }
  );
  const idle = idleSpans
    .map((span) => ({ a: Date.parse(span.startT), b: Date.parse(span.endT) }))
    .filter((span) => !(Number.isNaN(span.a) || Number.isNaN(span.b)))
    .sort((x, y) => x.a - y.a);

  const endedMs = args.endedAt ? Date.parse(args.endedAt) : Number.NaN;
  const windowEnd = Math.max(
    Number.isNaN(endedMs) ? Number.NEGATIVE_INFINITY : endedMs,
    idle.at(-1)?.b ?? Number.NEGATIVE_INFINITY,
    maxItemMs(args.items),
    startMs
  );
  if (windowEnd <= startMs) {
    return [];
  }

  const iso = (ms: number) => new Date(ms).toISOString();
  const bursts: BurstSpan[] = [];
  let cursor = startMs;
  let pendingResumption = false;
  for (const span of idle) {
    const a = Math.max(cursor, span.a);
    const b = Math.min(windowEnd, span.b);
    if (a > cursor) {
      bursts.push({
        startT: iso(cursor),
        endT: iso(a),
        isResumption: pendingResumption,
      });
      pendingResumption = false;
    }
    if (b > a) {
      cursor = b;
      pendingResumption = true;
    }
  }
  if (windowEnd > cursor) {
    bursts.push({
      startT: iso(cursor),
      endT: iso(windowEnd),
      isResumption: pendingResumption,
    });
  }
  return bursts;
}
