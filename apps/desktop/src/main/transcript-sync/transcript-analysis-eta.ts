/**
 * @file transcript-analysis-eta.ts
 * @description ISS-8507 - estimate how much transcript analysis is left, and
 * refuse to state a number the evidence does not support.
 *
 * `report` answers in a fixed order and that order is the contract. Three rules
 * inside it are easy to invert:
 *
 *  - **Recording the highest revision seen is unconditional and comes first**,
 *    ahead of every short-circuit. A report that exits early above it stops the
 *    counter advancing, and `rebase` would then accept an inventory this fold
 *    already has proof is stale.
 *  - **Liveness is not stale-revision-scoped; byte NUMBERS are.** A `failed`
 *    report tagged with an old revision is still a true fact about the parser.
 *    Filtering it out as a stale write leaves the fold replaying whatever it
 *    last said - a dead lane keeping its countdown, or keeping a completion.
 *  - **Supersession outranks liveness**, because a newer inventory means this
 *    fold has to be REPLACED whatever the lane is doing.
 *
 * STALL IS DERIVED IN `current()`, NOT ONLY IN `report`. A parser that wedges
 * stops calling `report`, so a fold that checked only on write would freeze on
 * its last measured value and never transition - the exact failure the criterion
 * exists to catch. `current()` re-derives staleness PURELY: it commits nothing,
 * and it only ever re-labels a `measured` or `calculating` state, so a `complete`
 * fold left idle is not retracted just because the caller waited. The stall clock
 * moves only on progress that actually happened, never on a report that merely
 * arrives, which is what lets a lane still talking without advancing reach it.
 */

import { IMPORT_NO_MOVEMENT_GIVE_UP_MS } from "../../shared/historical-import-bounds.js";
import {
  defaultProfilingClock,
  type ProfilingClock,
  readMonotonicMs,
} from "../../shared/profiling.js";
import {
  ANALYSIS_ETA_CONTRACT_VERSION,
  AnalysisEtaConfidence,
  AnalysisEtaKind,
  AnalysisEtaUnavailableReason,
  AnalysisParserActivity,
  type TranscriptAnalysisEta,
} from "../../shared/transcript-analysis-eta-contract.js";
import type { TranscriptByteInventory } from "./transcript-byte-inventory-types.js";
import {
  ByteProgressKind,
  canStateParseTotal,
  type ParseProgressState,
} from "./transcript-byte-progress.js";
import {
  createThroughputWindow,
  MAX_THROUGHPUT_SAMPLES,
  MIN_SAMPLES_FOR_ESTIMATE,
} from "./transcript-throughput-window.js";

/** Absolute floor on measured VOLUME before an estimate may be extrapolated. */
const MIN_OBSERVED_BYTES = 1024 * 1024;

/** Milliseconds of retained span the rate must cover. */
const MIN_RETAINED_SPAN_MS = 2000;

/** How much worse a raw estimate must get before the published one rises. */
const MATERIAL_INCREASE_RATIO = 0.2;

/** The gate closes only when a floor falls below this fraction of itself. */
const GATE_CLOSE_FRACTION = 0.5;

export type AnalysisEtaPolicy = {
  maxSamples: number;
  minSamplesForEstimate: number;
  minRetainedSpanMs: number;
  minObservedBytes: number;
  stallAfterMs: number;
  materialIncreaseRatio: number;
};

/**
 * `stallAfterMs` is DERIVED from the sanctioned no-movement give-up, never
 * restated. That constant is one poll interval past the longest a single source
 * may legitimately hold the loop without the count moving, and its own file
 * warns that a give-up any tighter is arithmetically guaranteed to accuse a
 * healthy historical import, while a wider one is a product judgement it does
 * not own. A private literal here would have been both a duplicate and, at two
 * minutes, wrong - accusing a lane the main process had explicitly granted the
 * time.
 */
export const DEFAULT_ANALYSIS_ETA_POLICY: AnalysisEtaPolicy = {
  materialIncreaseRatio: MATERIAL_INCREASE_RATIO,
  maxSamples: MAX_THROUGHPUT_SAMPLES,
  minObservedBytes: MIN_OBSERVED_BYTES,
  minRetainedSpanMs: MIN_RETAINED_SPAN_MS,
  minSamplesForEstimate: MIN_SAMPLES_FOR_ESTIMATE,
  stallAfterMs: IMPORT_NO_MOVEMENT_GIVE_UP_MS,
};

export type AnalysisEtaDeps = {
  clock?: ProfilingClock;
  policy?: AnalysisEtaPolicy;
};

/** One reading of the lane, as the caller sees it. */
export type AnalysisEtaObservation = {
  /**
   * The revision of the inventory that produced `parse`.
   *
   * A caller that re-inventories must either call {@link AnalysisEtaFold.rebase}
   * or begin reporting the NEW revision. Passing a fold-bound constant forever
   * means a newer inventory can never be detected here, and the estimate counts
   * down against a denominator that has been superseded.
   */
  revision: number;
  parse: ParseProgressState;
  activity: AnalysisParserActivity;
};

export type AnalysisEtaFold = {
  report: (observation: AnalysisEtaObservation) => TranscriptAnalysisEta;
  /** Time-dependent and PURE: derives staleness, commits nothing. */
  current: () => TranscriptAnalysisEta;
  rebase: (next: TranscriptByteInventory) => AnalysisEtaFold;
};

/** Where the last interval started, for the next sample. */
type IntervalAnchor = {
  atMs: number;
  processedBytes: number;
};

export function createAnalysisEta(
  inventory: TranscriptByteInventory,
  deps: AnalysisEtaDeps = {}
): AnalysisEtaFold {
  const clock = deps.clock ?? defaultProfilingClock;
  const policy = deps.policy ?? DEFAULT_ANALYSIS_ETA_POLICY;
  const window = createThroughputWindow(
    policy.maxSamples,
    policy.minSamplesForEstimate
  );

  let anchor: IntervalAnchor | null = null;
  let lastAdvanceMs: number | null = null;
  let publishedRemainingMs: number | null = null;
  let lifetimeActiveMs = 0;
  let lifetimeObservedBytes = 0;
  let gateOpen = false;
  let superseded = false;
  let highestRevisionSeen = inventory.inventoryRevision;
  let state: TranscriptAnalysisEta = initialState(inventory);

  /** What every kind this fold states carries. Fixed for its whole life. */
  const common = {
    contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
    inventoryRevision: inventory.inventoryRevision,
  } as const;

  const commit = (next: TranscriptAnalysisEta): TranscriptAnalysisEta => {
    state = next;
    return state;
  };

  /** Every exit that is neither a sampling pass nor an anchor-only pass. */
  const breakChain = (next: TranscriptAnalysisEta): TranscriptAnalysisEta => {
    anchor = null;
    return commit(next);
  };

  /** The shape alone. Two callers below need it WITHOUT breaking the chain. */
  const unavailableState = (
    reason: AnalysisEtaUnavailableReason
  ): TranscriptAnalysisEta => ({
    ...common,
    kind: AnalysisEtaKind.Unavailable,
    reason,
  });

  const unavailable = (
    reason: AnalysisEtaUnavailableReason
  ): TranscriptAnalysisEta => breakChain(unavailableState(reason));

  const complete = (): TranscriptAnalysisEta =>
    breakChain({ ...common, kind: AnalysisEtaKind.Complete });

  const calculating = (): TranscriptAnalysisEta =>
    commit({
      ...common,
      activeElapsedMs: lifetimeActiveMs,
      kind: AnalysisEtaKind.Calculating,
      retainedSampleCount: window.retainedSampleCount(),
    });

  /**
   * Fold the interval that ended at `nowMs`, if there is one to fold.
   *
   * Returns nothing: its whole job is the three-way anchor outcome, the two
   * events that move the stall clock, and refusing an interval that outlasted
   * the no-movement budget.
   */
  const observeInterval = (nowMs: number, processedBytes: number): void => {
    if (lastAdvanceMs !== null && nowMs < lastAdvanceMs) {
      // The clock went BACKWARD. `readMonotonicMs` cannot catch this - a
      // regressed reading is still finite - and the sample predicate only
      // refuses the resulting negative duration, which leaves the anchor and
      // the stall clock free to be rewritten with a past timestamp. Once the
      // clock recovers, the gap to that rewound mark exceeds the stall bound
      // and a lane that just made progress is accused of being wedged. An
      // unusable reading is an unusable reading: change nothing.
      return;
    }
    if (anchor === null) {
      anchor = { atMs: nowMs, processedBytes };
      lastAdvanceMs = nowMs;
      return;
    }
    const deltaBytes = processedBytes - anchor.processedBytes;
    if (deltaBytes <= 0) {
      return;
    }
    const durationMs = nowMs - anchor.atMs;
    // An interval that OUTLASTS the no-movement budget contains an outage, so it
    // is discarded rather than folded. `stallHere` guards only the report that
    // did not advance; a parser that goes silent past the bound and comes back
    // carrying progress reaches this fold first, and measuring that span counts
    // the silence as active time and hands the window an outlier the trim
    // absorbs once and not twice. The bound is read against the ANCHOR, not the
    // stall clock, because `stallHere` deliberately leaves the stall clock
    // behind - reading it there would discard the legitimate short interval that
    // follows a committed stall. The progress itself is real either way, so the
    // anchor and the stall clock both move to it and the NEXT interval measures.
    if (
      durationMs < policy.stallAfterMs &&
      window.add({ bytes: deltaBytes, durationMs })
    ) {
      lifetimeActiveMs += durationMs;
      lifetimeObservedBytes += deltaBytes;
    }
    anchor = { atMs: nowMs, processedBytes };
    lastAdvanceMs = nowMs;
  };

  /**
   * The stall refusal: keep observing, but do not carry the outage forward.
   *
   * The anchor is RE-SEATED rather than kept or cleared, and the two halves are
   * separately load-bearing. Keeping a stale anchor folds the entire silent span
   * into the next accepted sample, which counts idle time as active analysis
   * time (`activeElapsedMs` is documented as measured active time and is
   * monotone, so it never recovers) and hands the window one enormous slow
   * sample - survivable once, because the trim drops a single extreme, and not
   * twice: two stalls inside one window collapse the rate and publish an
   * estimate ~64x too high. Clearing it instead sends the next report down the
   * anchor-only path, which re-anchors the STALL clock, so a lane that is still
   * making no progress bounces back to `measured` and the state becomes
   * unreachable for the case it exists to catch. Re-seating gives both: the
   * outage is never measured, and the silence keeps accruing.
   *
   * This covers only the outage a report ARRIVES during. A parser that goes
   * silent and comes back carrying progress never reaches here, because the
   * interval fold above advances the stall clock first - that half is the
   * duration bound in `observeInterval`, and neither half subsumes the other.
   */
  const stallHere = (
    nowMs: number,
    processedBytes: number
  ): TranscriptAnalysisEta => {
    anchor = { atMs: nowMs, processedBytes };
    return commit(unavailableState(AnalysisEtaUnavailableReason.Stalled));
  };

  const updateGate = (totalBytes: number): void => {
    const requiredBytes = Math.min(
      policy.minObservedBytes,
      Math.floor(totalBytes / 2)
    );
    const samples = window.retainedSampleCount();
    const spanMs = window.retainedSpanMs();
    if (gateOpen) {
      gateOpen = !gateHasCollapsed(samples, spanMs, policy);
      return;
    }
    gateOpen =
      samples >= policy.minSamplesForEstimate &&
      spanMs >= policy.minRetainedSpanMs &&
      lifetimeObservedBytes >= requiredBytes;
  };

  const publish = (rawRemainingMs: number): number => {
    if (
      publishedRemainingMs === null ||
      rawRemainingMs <= publishedRemainingMs
    ) {
      publishedRemainingMs = rawRemainingMs;
      return rawRemainingMs;
    }
    const threshold = publishedRemainingMs * (1 + policy.materialIncreaseRatio);
    if (rawRemainingMs >= threshold) {
      publishedRemainingMs = rawRemainingMs;
      return rawRemainingMs;
    }
    return publishedRemainingMs;
  };

  const measure = (
    processedBytes: number,
    totalBytes: number
  ): TranscriptAnalysisEta => {
    updateGate(totalBytes);
    const rate = window.rateBytesPerMs();
    if (!(gateOpen && rate !== null)) {
      return calculating();
    }
    const remainingBytes = totalBytes - processedBytes;
    const rawRemainingMs = remainingBytes / rate;
    if (!(Number.isFinite(rawRemainingMs) && rawRemainingMs > 0)) {
      return calculating();
    }
    return commit({
      ...common,
      activeElapsedMs: lifetimeActiveMs,
      confidence: window.isFull()
        ? AnalysisEtaConfidence.Established
        : AnalysisEtaConfidence.Provisional,
      kind: AnalysisEtaKind.Measured,
      rawRemainingMs,
      remainingBytes,
      remainingMs: publish(rawRemainingMs),
      retainedSampleCount: window.retainedSampleCount(),
      throughputBytesPerMs: rate,
    });
  };

  const advanceRunning = (parse: ParseProgressState): TranscriptAnalysisEta => {
    if (parse.kind === ByteProgressKind.Empty) {
      return complete();
    }
    if (parse.kind === ByteProgressKind.Indeterminate) {
      return unavailable(AnalysisEtaUnavailableReason.ProgressIndeterminate);
    }
    if (parse.kind !== ByteProgressKind.Measured) {
      const unreachable: never = parse;
      return unreachable;
    }
    // The revision guard above catches a denominator that ANNOUNCES itself as
    // new. This catches the one that does not: a stale or mixed parse state
    // carrying the bound revision but a different total. Both readings claim to
    // describe the same source set, so nothing downstream can tell them apart -
    // a smaller total marks the estimate `complete` while the inventory still
    // has eligible bytes left, and a total of any other size divides the
    // remainder by a denominator this fold was never bound to. Fail closed
    // rather than pick one: the fold is bound to ONE inventory, and a parse lane
    // that disagrees with it about the size of the job has not told us how far
    // along it is.
    if (parse.totalBytes !== inventory.eligibleParseBytes) {
      return unavailable(AnalysisEtaUnavailableReason.ProgressIndeterminate);
    }
    if (parse.processedBytes >= parse.totalBytes) {
      return complete();
    }
    const nowMs = readMonotonicMs(clock);
    if (nowMs === null) {
      anchor = null;
      return state;
    }
    observeInterval(nowMs, parse.processedBytes);
    if (isStale(nowMs, lastAdvanceMs, policy.stallAfterMs)) {
      return stallHere(nowMs, parse.processedBytes);
    }
    return measure(parse.processedBytes, parse.totalBytes);
  };

  const report = (
    observation: AnalysisEtaObservation
  ): TranscriptAnalysisEta => {
    highestRevisionSeen = Math.max(highestRevisionSeen, observation.revision);
    if (superseded) {
      return state;
    }
    if (observation.revision > inventory.inventoryRevision) {
      superseded = true;
      return unavailable(AnalysisEtaUnavailableReason.Superseded);
    }
    if (observation.activity === AnalysisParserActivity.Failed) {
      return unavailable(AnalysisEtaUnavailableReason.Failed);
    }
    if (observation.activity === AnalysisParserActivity.Paused) {
      return unavailable(AnalysisEtaUnavailableReason.Paused);
    }
    if (observation.revision < inventory.inventoryRevision) {
      anchor = null;
      return state;
    }
    return advanceRunning(observation.parse);
  };

  const current = (): TranscriptAnalysisEta => {
    if (
      state.kind !== AnalysisEtaKind.Measured &&
      state.kind !== AnalysisEtaKind.Calculating
    ) {
      return state;
    }
    const nowMs = readMonotonicMs(clock);
    if (nowMs === null) {
      return state;
    }
    if (!isStale(nowMs, lastAdvanceMs, policy.stallAfterMs)) {
      return state;
    }
    // Returned, never committed: this derivation is what keeps `current()` pure.
    return unavailableState(AnalysisEtaUnavailableReason.Stalled);
  };

  const fold: AnalysisEtaFold = {
    current,
    report,
    rebase: (next: TranscriptByteInventory) => {
      const accepted =
        next.inventoryRevision >= highestRevisionSeen &&
        next.inventoryRevision > inventory.inventoryRevision;
      if (accepted) {
        return createAnalysisEta(next, deps);
      }
      return fold;
    },
  };
  return fold;
}

/**
 * Whether the gate should close again.
 *
 * Hysteresis rather than a latch. A latch cannot close, and the sample window
 * turns over completely - sixteen samples of one byte apiece leave the rate
 * resting on fourteen milliseconds of evidence while the gate stays open and
 * publishes an extrapolation measured in weeks, which is the cold-start guess
 * this whole module refuses, arriving one step later than expected. A live floor
 * with no hysteresis has the opposite fault: the retained span dips on ordinary
 * eviction and the estimate flickers back to `calculating` on a perfectly
 * healthy lane. Closing only below HALF each floor keeps the guard and kills the
 * flicker, and costs one predicate rather than a state variable and its reset.
 *
 * ONLY THE COUNT AND SPAN HALVES CAN CLOSE IT, and the byte floor is absent here
 * rather than forgotten. That floor reads a MONOTONE lifetime accumulator over a
 * total that is fixed for the revision, so once the gate has opened the byte
 * condition can never become true again: the accumulator only grows and the
 * requirement never rises. A third clause for it would be unreachable code, and
 * mutation testing said so - the two mutants on it survived because no input can
 * distinguish them. It is a lifetime accumulator on purpose, though: measured on
 * the retained window instead it would be unreachable in the OTHER direction -
 * the window keeps sixteen, the trim drops two, and fourteen samples of 64 KiB
 * never reach a mebibyte, so the estimate would sit at `calculating` for ever.
 */
function gateHasCollapsed(
  retainedSamples: number,
  retainedSpanMs: number,
  policy: AnalysisEtaPolicy
): boolean {
  return (
    retainedSamples < policy.minSamplesForEstimate * GATE_CLOSE_FRACTION ||
    retainedSpanMs < policy.minRetainedSpanMs * GATE_CLOSE_FRACTION
  );
}

/**
 * Whether the lane has been silent for longer than the sanctioned budget.
 *
 * A NULL mark is "not started", never "wedged", and the fold deliberately has no
 * creation-time mark to make it otherwise. The mark is seated by the first
 * running report over a measured parse lane - the first evidence that a parser
 * exists at all - whereas a fold is constructed from an INVENTORY, which says
 * nothing about whether anyone has started parsing. Seating the mark at
 * construction would start the clock on a lane the caller has not begun, and
 * report a stall against a parser that was never asked to run; that is exactly
 * the healthy-import accusation the derived bound's own file warns about. Silence
 * before the first reading is indistinguishable from a lane that has not been
 * started, so the fold says `calculating` - which claims nothing - instead of
 * naming a stall it cannot actually see.
 */
function isStale(
  nowMs: number,
  lastAdvanceMs: number | null,
  stallAfterMs: number
): boolean {
  if (lastAdvanceMs === null) {
    return false;
  }
  return nowMs - lastAdvanceMs >= stallAfterMs;
}

/**
 * What the fold says before anything has been reported.
 *
 * Mirrors `initialParseState`, through the same predicate rather than a second
 * copy of it: a `partial` PARSE lane measured bytes, so the estimate starts
 * CALCULATING over them exactly as a complete one does (ISS-8346 ruling of
 * 2026-09-04), and only a lane that measured nothing starts indeterminate. The
 * UPLOAD lane's completeness is not consulted - an unmaterialized OpenCode
 * projection shortens that lane and must not withhold this number.
 */
function initialState(
  inventory: TranscriptByteInventory
): TranscriptAnalysisEta {
  const common = {
    contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
    inventoryRevision: inventory.inventoryRevision,
  } as const;
  if (!canStateParseTotal(inventory)) {
    return {
      ...common,
      kind: AnalysisEtaKind.Unavailable,
      reason: AnalysisEtaUnavailableReason.ProgressIndeterminate,
    };
  }
  if (inventory.eligibleParseBytes === 0) {
    return { ...common, kind: AnalysisEtaKind.Complete };
  }
  return {
    ...common,
    activeElapsedMs: 0,
    kind: AnalysisEtaKind.Calculating,
    retainedSampleCount: 0,
  };
}
