/**
 * @file transcript-analysis-eta-fixtures.ts
 * @description ISS-8507 — shared setup for the estimate's two suites.
 *
 * The suites split by responsibility (lifecycle and liveness in one, revisions
 * and the published number in the other) and both need the same inventory, the
 * same controllable clock, and the same warm-up, so it lives here rather than
 * being written twice.
 *
 * Nothing here asserts. A precondition that fails throws with the state it saw,
 * so a broken fixture reads as a broken fixture rather than as a failed case.
 */

import {
  type AnalysisEtaFold,
  createAnalysisEta,
} from "../src/main/transcript-sync/transcript-analysis-eta.js";
import {
  type ExclusionTally,
  TRANSCRIPT_EXCLUSION_REASONS,
  type TranscriptByteInventory,
  type TranscriptExclusionReason,
  TranscriptHarnessOutcome,
  TranscriptInventoryCompleteness,
} from "../src/main/transcript-sync/transcript-byte-inventory-types.js";
import {
  ByteProgressKind,
  type ParseProgressState,
} from "../src/main/transcript-sync/transcript-byte-progress.js";
import { TranscriptSourceHarness } from "../src/main/transcript-sync/transcript-sync-types.js";
import type { ProfilingClock } from "../src/shared/profiling.js";
import {
  AnalysisEtaKind,
  type AnalysisEtaUnavailableReason,
  AnalysisParserActivity,
  type MeasuredAnalysisEta,
  type TranscriptAnalysisEta,
} from "../src/shared/transcript-analysis-eta-contract.js";

export const BOUND_REVISION = 5;
/** Bytes each warm-up report consumes, and the span it covers. */
export const WARM_BYTES = 200_000;
export const WARM_MS = 500;
/** 400 B/ms — the rate every warm-up in these suites establishes. */
export const WARM_RATE = WARM_BYTES / WARM_MS;
/** Large enough that the remainder barely moves while the rate changes. */
export const LARGE_TOTAL = 1_000_000_000_000;
export const MODEST_TOTAL = 10_000_000;

/** How a {@link TestClock} can stop being readable partway through a fold. */
export const BrokenClockMode = {
  Throws: "throws",
  NonFinite: "non-finite",
} as const;
export type BrokenClockMode =
  (typeof BrokenClockMode)[keyof typeof BrokenClockMode];

export const BROKEN_CLOCK_MODES: readonly BrokenClockMode[] =
  Object.values(BrokenClockMode);

export type TestClock = {
  clock: ProfilingClock;
  advance: (ms: number) => void;
  /**
   * Break the SAME clock object the fold already holds.
   *
   * A fold captures its clock at construction, so a separately-built broken
   * clock can only ever be given to a fold that has never read a usable one -
   * and such a fold has no stall mark, which short-circuits the staleness
   * comparison on its own. Breaking in place is the only way to reach the
   * unreadable-clock branches of a fold that is actually running.
   */
  breakWith: (mode: BrokenClockMode) => void;
};

export type WarmRun = {
  fold: AnalysisEtaFold;
  clock: TestClock;
  processedBytes: number;
};

function emptyTallies(): Readonly<
  Record<TranscriptExclusionReason, ExclusionTally>
> {
  const tallies = {} as Record<TranscriptExclusionReason, ExclusionTally>;
  for (const reason of TRANSCRIPT_EXCLUSION_REASONS) {
    tallies[reason] = { bytes: 0, files: 0 };
  }
  return tallies;
}

/**
 * A byte inventory carrying only what the estimate reads: its revision, whether
 * the PARSE lane may state a total, and that total. Everything else is a valid
 * but inert shape, because this fold never looks at it.
 */
export function inventory(
  overrides: {
    revision?: number;
    eligibleParseBytes?: number;
    parseCompleteness?: TranscriptInventoryCompleteness;
  } = {}
): TranscriptByteInventory {
  const eligibleParseBytes = overrides.eligibleParseBytes ?? MODEST_TOTAL;
  return {
    attributableRawBytes: eligibleParseBytes,
    discoveredBytes: eligibleParseBytes,
    eligibleFiles: [],
    sessionsByHarness: [],
    eligibleParseBytes,
    enumeratedHarnesses: [TranscriptSourceHarness.Claude],
    evidence: [
      {
        harness: TranscriptSourceHarness.Claude,
        outcome: TranscriptHarnessOutcome.Measured,
      },
    ],
    excludedBytes: 0,
    exclusionsByReason: emptyTallies(),
    impairments: [],
    inventoryRevision: overrides.revision ?? BOUND_REVISION,
    parseCompleteness:
      overrides.parseCompleteness ?? TranscriptInventoryCompleteness.Complete,
    physicalBytes: eligibleParseBytes,
    uploadCompleteness: TranscriptInventoryCompleteness.Complete,
    uploadExclusionsByReason: emptyTallies(),
  };
}

export function measured(
  processedBytes: number,
  totalBytes: number
): ParseProgressState {
  return {
    kind: ByteProgressKind.Measured,
    processedBytes,
    ratio: processedBytes / totalBytes,
    totalBytes,
  };
}

export function testClock(): TestClock {
  let nowMs = 1000;
  let broken: BrokenClockMode | null = null;
  const read = (): number => {
    if (broken === BrokenClockMode.Throws) {
      throw new Error("clock unavailable");
    }
    if (broken === BrokenClockMode.NonFinite) {
      return Number.NaN;
    }
    return nowMs;
  };
  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    breakWith: (mode: BrokenClockMode) => {
      broken = mode;
    },
    clock: { nowEpochMs: () => 0, nowMs: read },
  };
}

export function throwingClock(): ProfilingClock {
  return {
    nowEpochMs: () => 0,
    nowMs: () => {
      throw new Error("clock unavailable");
    },
  };
}

export function nonFiniteClock(): ProfilingClock {
  return { nowEpochMs: () => 0, nowMs: () => Number.NaN };
}

/** Drives `sampleCount` running reports plus the anchor-only one before them. */
export function drive(
  fold: AnalysisEtaFold,
  clock: TestClock,
  options: {
    sampleCount: number;
    totalBytes: number;
    bytesPerReport?: number;
    msPerReport?: number;
    revision?: number;
  }
): { state: TranscriptAnalysisEta; processedBytes: number } {
  const bytes = options.bytesPerReport ?? WARM_BYTES;
  const durationMs = options.msPerReport ?? WARM_MS;
  const revision = options.revision ?? BOUND_REVISION;
  let processedBytes = 0;
  let state = reportRunning(fold, processedBytes, options.totalBytes, revision);
  for (let index = 0; index < options.sampleCount; index += 1) {
    clock.advance(durationMs);
    processedBytes += bytes;
    state = reportRunning(fold, processedBytes, options.totalBytes, revision);
  }
  return { processedBytes, state };
}

/**
 * One report over a MEASURED parse lane.
 *
 * The three exported wrappers below carry the defaults and are what cases call.
 * A parse lane that is empty or indeterminate is not this shape, so those cases
 * still build their own observation.
 */
function reportActivity(
  fold: AnalysisEtaFold,
  activity: AnalysisParserActivity,
  processedBytes: number,
  totalBytes: number,
  revision: number
): TranscriptAnalysisEta {
  return fold.report({
    activity,
    parse: measured(processedBytes, totalBytes),
    revision,
  });
}

export function reportRunning(
  fold: AnalysisEtaFold,
  processedBytes: number,
  totalBytes: number = MODEST_TOTAL,
  revision: number = BOUND_REVISION
): TranscriptAnalysisEta {
  return reportActivity(
    fold,
    AnalysisParserActivity.Running,
    processedBytes,
    totalBytes,
    revision
  );
}

export function reportPaused(
  fold: AnalysisEtaFold,
  processedBytes: number,
  totalBytes: number = MODEST_TOTAL,
  revision: number = BOUND_REVISION
): TranscriptAnalysisEta {
  return reportActivity(
    fold,
    AnalysisParserActivity.Paused,
    processedBytes,
    totalBytes,
    revision
  );
}

export function reportFailed(
  fold: AnalysisEtaFold,
  processedBytes: number,
  totalBytes: number = MODEST_TOTAL,
  revision: number = BOUND_REVISION
): TranscriptAnalysisEta {
  return reportActivity(
    fold,
    AnalysisParserActivity.Failed,
    processedBytes,
    totalBytes,
    revision
  );
}

/** Seven samples at 400 B/ms over 2500 ms and 1.4 MB — past all three floors. */
export function warmToMeasured(totalBytes: number = MODEST_TOTAL): WarmRun {
  const clock = testClock();
  const fold = createAnalysisEta(
    inventory({ eligibleParseBytes: totalBytes }),
    { clock: clock.clock }
  );
  const { state, processedBytes } = drive(fold, clock, {
    sampleCount: 7,
    totalBytes,
  });
  expectMeasured(state);
  return { clock, fold, processedBytes };
}

/** Narrows to a measured estimate, throwing with what it actually saw. */
export function expectMeasured(
  state: TranscriptAnalysisEta
): MeasuredAnalysisEta {
  if (state.kind !== AnalysisEtaKind.Measured) {
    throw new Error(`expected a measured estimate, got ${state.kind}`);
  }
  return state;
}

/** The reason an estimate is unavailable, or `null` when it is not. */
export function reasonOf(
  state: TranscriptAnalysisEta
): AnalysisEtaUnavailableReason | null {
  return state.kind === AnalysisEtaKind.Unavailable ? state.reason : null;
}
