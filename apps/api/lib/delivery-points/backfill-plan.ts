/**
 * Segmentation and throttling for a delivery backfill (ISS-8399).
 *
 * Pure: no provider, no database, no clock of its own. It answers one question —
 * given a lookback and a segment size, which windows do we ask for and in what
 * order — so the answer is testable without a provider, and so a second
 * provider inherits it rather than reimplementing it.
 *
 * ORDER IS NEWEST-FIRST, deliberately. A backfill can be interrupted (a
 * serverless ceiling, a provider outage, an operator stopping it), and the half
 * that ran should be the half a reader is most likely to look at. It also means
 * an interrupted run leaves a CONTIGUOUS recent range rather than a gap in the
 * middle, which is the difference between "coverage starts at date X" and
 * "coverage has a hole nobody can see".
 */

import { toIsoDateOnly } from "@/lib/date-only";

const MS_PER_DAY = 86_400_000;

/** One inclusive `[startDate, endDate]` window to request from the provider. */
export type BackfillSegment = {
  readonly startDate: string;
  readonly endDate: string;
};

export type BackfillPlanInput = {
  /** The most recent day to cover, inclusive. */
  readonly endDate: Date;
  /** How many days back from `endDate` to cover, inclusive of `endDate`. */
  readonly lookbackDays: number;
  /** Days per request window. */
  readonly segmentDays: number;
  /**
   * Hard ceiling on how many windows one run may plan, so a mis-set lookback
   * cannot turn into thousands of provider requests.
   */
  readonly maxSegments?: number;
};

/** Default ceiling on segments per run. */
export const DEFAULT_MAX_BACKFILL_SEGMENTS = 60;

/** Default delay between segments, to stay well inside provider rate limits. */
export const DEFAULT_SEGMENT_THROTTLE_MS = 1000;

/**
 * Plan the windows for one backfill run, newest first.
 *
 * Both sizes are clamped at BOTH ends: a `Math.min` alone would let a negative
 * or zero `segmentDays` produce an infinite loop, and a negative `lookbackDays`
 * would silently produce no work at all while reading as a completed run.
 *
 * The oldest segment is TRUNCATED to the lookback rather than extended past it,
 * so the planned range never covers days the caller did not ask for.
 */
export function planBackfillSegments(
  input: BackfillPlanInput
): BackfillSegment[] {
  const lookbackDays = requireDayCount("lookbackDays", input.lookbackDays);
  const segmentDays = requireDayCount("segmentDays", input.segmentDays);
  const maxSegments = requireDayCount(
    "maxSegments",
    input.maxSegments ?? DEFAULT_MAX_BACKFILL_SEGMENTS
  );
  requireUsableEndDate(input.endDate);

  // Normalize to a UTC midnight so segment boundaries are calendar days rather
  // than a moving instant — two runs on the same day must plan the same windows.
  const endUtcMs = Date.UTC(
    input.endDate.getUTCFullYear(),
    input.endDate.getUTCMonth(),
    input.endDate.getUTCDate()
  );
  const earliestUtcMs = endUtcMs - (lookbackDays - 1) * MS_PER_DAY;

  const segments: BackfillSegment[] = [];
  let segmentEndMs = endUtcMs;
  while (segmentEndMs >= earliestUtcMs && segments.length < maxSegments) {
    const rawStartMs = segmentEndMs - (segmentDays - 1) * MS_PER_DAY;
    const segmentStartMs = Math.max(rawStartMs, earliestUtcMs);
    segments.push({
      startDate: toIsoDateOnly(new Date(segmentStartMs)),
      endDate: toIsoDateOnly(new Date(segmentEndMs)),
    });
    segmentEndMs = segmentStartMs - MS_PER_DAY;
  }
  return segments;
}

/**
 * Did the plan stop short of the requested lookback because it hit
 * `maxSegments`? A truncated plan covers less than the caller asked for, and
 * saying so is the difference between "the window was quiet" and "we never
 * asked".
 */
export function isPlanTruncated(
  input: BackfillPlanInput,
  segments: readonly BackfillSegment[]
): boolean {
  const lookbackDays = requireDayCount("lookbackDays", input.lookbackDays);
  const segmentDays = requireDayCount("segmentDays", input.segmentDays);
  const required = Math.ceil(lookbackDays / segmentDays);
  return segments.length < required;
}

/**
 * Clamp a day count at the low end, and REFUSE a non-finite one.
 *
 * `Math.max(1, Math.floor(NaN))` is `NaN`, which propagates all the way to an
 * empty plan with `planTruncated` false — a mis-set config that is byte-for-byte
 * indistinguishable from a run that asked for everything and found a quiet
 * period. Throwing is the only answer that cannot be mistaken for a
 * measurement; the caller's own segment-failure reporting has nothing to say
 * about a window it never planned.
 */
function requireDayCount(label: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `Backfill plan input "${label}" must be a finite number of days; received ${value}.`
    );
  }
  return Math.max(1, Math.floor(value));
}

/** An Invalid Date reaches the same empty-plan-that-looks-complete end. */
function requireUsableEndDate(endDate: Date): void {
  if (Number.isNaN(endDate.getTime())) {
    throw new Error(
      'Backfill plan input "endDate" must be a valid Date; received an Invalid Date.'
    );
  }
}
