/**
 * @file transcript-throughput-window.ts
 * @description ISS-8507 - a bounded store of observed parse throughput, and the
 * one rate derived from it.
 *
 * THE TRIM RUNS ON READ, AND THE FLOORS READ WHAT THE TRIM LEFT. Every accessor
 * here reports the RETAINED set: what survives after the single fastest and
 * single slowest have been dropped, which is the set the rate is computed over
 * and is EMPTY until the trim can run at all. That is not a detail. A
 * floor measured over the accepted set while the rate is computed over the
 * trimmed one is defeated by the trim itself - five samples of `1 byte / 1996ms`
 * plus four of `1000 bytes / 1ms` clear a two-second floor, and then the trim
 * removes the long one and leaves the published number resting on about three
 * milliseconds of evidence. One set answers both questions, or neither is
 * answered.
 *
 * AGGREGATE, NOT A MEAN OF RATES. `sum(bytes) / sum(ms)` weights each sample by
 * how long it actually took, so a 3ms interval cannot outvote a 3s one. A mean
 * of per-sample rates would give them equal say, which is how one short burst
 * ends up owning the estimate.
 *
 * TRIM BOTH ENDS. Dropping only the slowest sample would bias every estimate
 * optimistic, which is the direction that hurts - a countdown that finishes late
 * is worse than one that finishes early. Symmetric trimming leaves the estimator
 * unbiased and still removes the single worst outlier in either direction.
 *
 * NO PER-SAMPLE MAGNITUDE CAP, DELIBERATELY. A cap on duration is not inert:
 * above the stall bound it is unreachable, below it it silently discards a
 * legitimately long interval, and there is no value that is defensibly neither.
 * Overflow is closed downstream instead, where it can be seen: the running sums
 * are checked against the exact-integer range and the rate must come out finite
 * AND positive, so a `Number.MAX_VALUE` duration reaches the sum, overflows it,
 * and is refused there.
 */

import { isMeasurableByteSize } from "./transcript-byte-inventory-fold.js";

/** One observed interval of parsing: bytes consumed, and how long it took. */
export type ThroughputSample = {
  bytes: number;
  durationMs: number;
};

/**
 * Samples the RETAINED set needs before a rate may be stated.
 *
 * The same constant governs the outlier trim, and that is the point rather than
 * a coincidence. When the publish floor sat below the trim floor, the FIRST
 * number the estimate ever stated was the one number with no outlier defense at
 * all. Tying them together makes that regime unrepresentable. Note the
 * arithmetic it implies: the trim drops two, so a retained floor of five needs
 * SEVEN accepted samples.
 */
export const MIN_SAMPLES_FOR_ESTIMATE = 5;

/** How many samples the window keeps. Oldest is evicted first. */
export const MAX_THROUGHPUT_SAMPLES = 16;

export type ThroughputWindow = {
  /** Returns whether the sample was accepted. A rejected one is counted, never summed. */
  add: (sample: ThroughputSample) => boolean;
  /**
   * Samples surviving the trim, and zero below the floor where nothing is
   * retained at all. Reaching the floor is necessary for a rate, not sufficient
   * - the trim drops two, so this count has its own floor to clear.
   */
  retainedSampleCount: () => number;
  /** Samples refused as not a real byte/duration pair. */
  rejectedSampleCount: () => number;
  /** Milliseconds spanned by the retained set. */
  retainedSpanMs: () => number;
  /** Bytes spanned by the retained set. */
  retainedObservedBytes: () => number;
  /** Whether the window is holding as many samples as it keeps. */
  isFull: () => boolean;
  /** The trimmed aggregate rate, or `null` when no rate may be stated. */
  rateBytesPerMs: () => number | null;
};

export function createThroughputWindow(
  maxSamples: number = MAX_THROUGHPUT_SAMPLES,
  minSamplesForEstimate: number = MIN_SAMPLES_FOR_ESTIMATE
): ThroughputWindow {
  const samples: ThroughputSample[] = [];
  let rejected = 0;
  // The trim sorts, and one estimate reads the retained set four times over. An
  // accepted sample is the only thing that can change it, so it is derived once
  // per change rather than once per accessor.
  let retainedCache: readonly ThroughputSample[] | null = null;

  const add = (sample: ThroughputSample): boolean => {
    if (!isUsableSample(sample)) {
      rejected += 1;
      return false;
    }
    samples.push(sample);
    if (samples.length > maxSamples) {
      samples.shift();
    }
    retainedCache = null;
    return true;
  };

  const retained = (): readonly ThroughputSample[] => {
    if (retainedCache === null) {
      retainedCache = trimExtremes(samples, minSamplesForEstimate);
    }
    return retainedCache;
  };

  return {
    add,
    isFull: () => samples.length >= maxSamples,
    rejectedSampleCount: () => rejected,
    retainedObservedBytes: () => sumOf(retained(), (s) => s.bytes),
    retainedSampleCount: () => retained().length,
    retainedSpanMs: () => sumOf(retained(), (s) => s.durationMs),
    rateBytesPerMs: () => aggregateRate(retained(), minSamplesForEstimate),
  };
}

/**
 * Whether a sample is a real byte/duration pair.
 *
 * The byte half is {@link isMeasurableByteSize}, which already owns "the WHOLE
 * impossible set, not the two that get remembered" for this directory - NaN,
 * both infinities, fractional values, anything past the exact-integer range, and
 * negatives. The only condition added on top is ETA-specific: a zero-byte
 * interval is a real observation of no progress, not a throughput sample, so it
 * is not summed into a rate.
 *
 * A duration only has to be finite and positive. A monotonic clock that runs
 * BACKWARD returns a perfectly finite number and sails through the clock
 * helper, so the positivity check here is the only thing between it and a
 * negative interval.
 */
function isUsableSample(sample: ThroughputSample): boolean {
  return (
    isMeasurableByteSize(sample.bytes) &&
    sample.bytes > 0 &&
    Number.isFinite(sample.durationMs) &&
    sample.durationMs > 0
  );
}

/**
 * The retained set: everything, minus the single fastest and single slowest by
 * rate, once there are enough samples for that to leave a quorum.
 *
 * Below the floor the retained set is EMPTY, not the accepted samples left
 * untrimmed. Reporting them untrimmed made the published count climb to four and
 * then FALL to three on the fifth accepted sample, because that fifth one is
 * what first lets the trim run - a consumer watching its own evidence saw it go
 * backwards at the moment it actually grew. There is no half-trimmed set to
 * report: either enough samples exist for the trim to leave a quorum, or nothing
 * is retained yet.
 */
function trimExtremes(
  samples: readonly ThroughputSample[],
  minSamplesForEstimate: number
): readonly ThroughputSample[] {
  if (samples.length < minSamplesForEstimate) {
    return [];
  }
  const byRate = [...samples].sort(
    (a, b) => a.bytes / a.durationMs - b.bytes / b.durationMs
  );
  return byRate.slice(1, byRate.length - 1);
}

/**
 * The trimmed aggregate rate, or `null` when none may be stated.
 *
 * `null` rather than 0 on every refusal, because a rate of zero is a claim about
 * a stopped lane and would extrapolate to an infinite remaining time. The
 * exact-integer check on the byte sum and the finite-and-positive check on the
 * rate are what close the overflow and the divide-by-nothing cases without any
 * per-sample magnitude constant.
 */
function aggregateRate(
  retained: readonly ThroughputSample[],
  minSamplesForEstimate: number
): number | null {
  if (retained.length < minSamplesForEstimate) {
    return null;
  }
  const totalBytes = sumOf(retained, (s) => s.bytes);
  const totalMs = sumOf(retained, (s) => s.durationMs);
  if (!(Number.isSafeInteger(totalBytes) && totalBytes > 0)) {
    return null;
  }
  if (!(Number.isFinite(totalMs) && totalMs > 0)) {
    return null;
  }
  const rate = totalBytes / totalMs;
  if (!(Number.isFinite(rate) && rate > 0)) {
    return null;
  }
  return rate;
}

function sumOf(
  samples: readonly ThroughputSample[],
  pick: (sample: ThroughputSample) => number
): number {
  let total = 0;
  for (const sample of samples) {
    total += pick(sample);
  }
  return total;
}
