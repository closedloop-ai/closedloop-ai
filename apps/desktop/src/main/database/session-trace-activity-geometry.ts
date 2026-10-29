/**
 * The Session Trace's activity GEOMETRY — where the collector's activity window
 * begins and ends, and which bucket a given instant falls in.
 *
 * Split out of `session-trace.ts` (ISS-5850) for the reason AGENTS.md gives:
 * that file must not grow, and
 * this ticket adds to `buildTraceActivityFields`, which is precisely the seam
 * these four helpers serve. They are the cluster that decides the extent the
 * bins tile — the fact ISS-5850 now states on the wire — so they belong in view
 * of each other rather than scattered down a 1,000-line module.
 *
 * Deliberately structural in its parameter types rather than importing
 * `TraceTimelineRow` / `SessionTraceSyncInput` back out of `session-trace.ts`:
 * these are arithmetic over timestamps, and a narrower contract keeps the
 * dependency one-way.
 */

import { parseIsoMs } from "../session/session-marker-utils.js";

/** `H:MM:SS` from a duration, the anchor-less offset the trace axis prints. */
export function formatTraceClockOffset(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * FEA-3586: the min/max parseable activity timestamp across the trace's timeline
 * rows and token events. Used to tighten the bucket/marker window to the real
 * activity span so a stale end anchor can't compress every bar into hour one.
 *
 * ISS-5850: this pair IS the extent the bins go on to tile, which is why the
 * producer can state it on the wire instead of leaving every consumer to assume
 * the bins span the window it happens to be drawing.
 */
export function activityExtentMs(
  timelineRows: readonly { createdAt: string }[],
  tokenEvents: readonly { created_at: string }[]
): { minMs: number; maxMs: number } {
  let minMs = Number.NaN;
  let maxMs = Number.NaN;
  const consider = (value: string) => {
    const ms = parseIsoMs(value);
    if (!Number.isFinite(ms)) {
      return;
    }
    // `!(a <= b)` / `!(a >= b)` so a NaN seed is always replaced by a real ms.
    if (!(minMs <= ms)) {
      minMs = ms;
    }
    if (!(maxMs >= ms)) {
      maxMs = ms;
    }
  };
  for (const row of timelineRows) {
    consider(row.createdAt);
  }
  for (const event of tokenEvents) {
    consider(event.created_at);
  }
  return { minMs, maxMs };
}

export function clampToRange(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/** The bucket `createdAt` lands in, clamped into `[0, bucketCount - 1]`. */
export function bucketIndex(
  createdAt: string,
  startMs: number,
  bucketMs: number,
  bucketCount: number
): number {
  const eventMs = parseIsoMs(createdAt);
  if (!Number.isFinite(eventMs)) {
    return 0;
  }
  const index = Math.floor((eventMs - startMs) / bucketMs);
  return Math.max(0, Math.min(bucketCount - 1, index));
}
