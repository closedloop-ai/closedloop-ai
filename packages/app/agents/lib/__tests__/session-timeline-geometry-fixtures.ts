import type { ActivityBucket } from "@repo/api/src/types/agent-session";

/** Jump-target-bearing bars before transcript-row repair. */
export function createActivityBuckets(count: number): ActivityBucket[] {
  return Array.from({ length: count }, (_, index) => ({
    byModel: {},
    cCache: 0,
    cIn: 0,
    cOut: 0,
    key: `bucket-${index}`,
    label: String(index),
    tl0: 999,
    toolStart: 0,
    total: 1,
  }));
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/** An exact clock boundary, so column alignment is readable in the assertions. */
export const SESSION_START_MS = Date.UTC(2026, 5, 10, 9, 0, 0);

/**
 * Uniformly priced, counted, jump-bearing bins — the shape both producers emit.
 *
 * Shared rather than re-declared per suite: the projection's window behaviour and
 * its producer-clock placement are pinned by separate files that have to be
 * describing the SAME strip for their conclusions to compose.
 */
export function costedBins(count: number): ActivityBucket[] {
  return Array.from({ length: count }, (_, index) => ({
    byModel: { "gpt-5.5": { cCache: 0.5, cIn: 1, cOut: 0.5 } },
    cCache: 0.5,
    cIn: 1,
    cOut: 0.5,
    key: `bin-${index}`,
    label: `bin ${index}`,
    tl0: index,
    toolStart: 1,
    total: 2,
  }));
}
