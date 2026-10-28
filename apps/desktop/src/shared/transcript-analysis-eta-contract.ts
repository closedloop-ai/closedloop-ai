/**
 * @file transcript-analysis-eta-contract.ts
 * @description ISS-8507 - what the desktop is allowed to SAY about how much
 * longer transcript analysis will take.
 *
 * FOUR KINDS, AND A ZERO IS NEVER ONE OF THEM. The acceptance criterion is that
 * a consumer can tell a measured estimate, a still-calculating one, an
 * unavailable one and a finished one apart "without inferring any of them from a
 * zero", so the four are a discriminated union on `kind` and nothing else. A
 * remaining time of `0` is a real measurement of a nearly-finished lane; it is
 * not how completion is reported, and it is not how absence is reported either.
 *
 * NOTHING BUT `measured` CARRIES A NUMBER. `stalled`, `paused`, `failed` and
 * `superseded` are REASONS under `unavailable`, deliberately not kinds of their
 * own: a reason cannot carry `remainingMs`, so a suspended or dead lane cannot
 * keep counting down. That is the shape the criterion asks for, enforced by the
 * type rather than by a rule someone has to remember.
 *
 * TWO REMAINING TIMES, ON PURPOSE. `remainingMs` is SMOOTHED - the fold holds a
 * previous value rather than raising it for a change under 20% (see
 * `transcript-analysis-eta.ts`). `rawRemainingMs` is the unsmoothed derivation,
 * and it is here so the payload stays checkable: `rawRemainingMs` always equals
 * `remainingBytes / throughputBytesPerMs`, so a consumer that re-derives the
 * estimate from the fields beside it gets an answer that reconciles. Shipping
 * only the smoothed value beside its own inputs would state a number that
 * contradicts them during every hold.
 *
 * WHY THIS LIVES IN `shared/`. ISS-8376 transports these values to the renderer
 * and ISS-8346 renders them, so the vocabulary crosses the main/renderer
 * boundary. `transcript-sync-status-contract.ts` states the rule this follows:
 * values that cross that boundary live in a shared, node-free module so the two
 * sides cannot drift, and the renderer tsconfig has no `@types/node`. Keep this
 * file free of node builtins and of anything that pulls them in.
 */

/** Whether an estimate exists, is still forming, is impossible, or is finished. */
export const AnalysisEtaKind = {
  /** A real remaining time backed by real throughput samples. */
  Measured: "measured",
  /**
   * The lane is running and being measured, but not yet enough to state a time.
   *
   * A distinct state rather than a `remainingMs` of 0 or a missing field: "we do
   * not know yet" and "there is almost none left" are different facts, and the
   * whole ticket exists because one was being rendered as the other.
   */
  Calculating: "calculating",
  /** No estimate can be made. The reason says why. */
  Unavailable: "unavailable",
  /** Every eligible byte is parsed, or there was nothing to parse. */
  Complete: "complete",
} as const;
export type AnalysisEtaKind =
  (typeof AnalysisEtaKind)[keyof typeof AnalysisEtaKind];

/** Why no estimate can be made. */
export const AnalysisEtaUnavailableReason = {
  /**
   * The parse lane cannot state a total, so there is no denominator.
   *
   * Comes straight from ISS-8506: only a `complete` parse inventory may be
   * stated as a total, and a short one would make every numerator look further
   * along than it is.
   */
  ProgressIndeterminate: "progress-indeterminate",
  /**
   * A NEWER inventory exists, so this fold may no longer speak.
   *
   * Distinct from a stale write, and load-bearing. A fold bound to one
   * inventory that has already reported `complete` would otherwise keep
   * replaying that completion after a later sweep found more files - a
   * completion claim that was true when made and is false now.
   */
  Superseded: "superseded",
  /** No byte has moved for longer than the sanctioned no-movement budget. */
  Stalled: "stalled",
  Paused: "paused",
  Failed: "failed",
} as const;
export type AnalysisEtaUnavailableReason =
  (typeof AnalysisEtaUnavailableReason)[keyof typeof AnalysisEtaUnavailableReason];

/** Every reason, so a projection or a test can be driven over the whole set. */
export const ANALYSIS_ETA_UNAVAILABLE_REASONS: readonly AnalysisEtaUnavailableReason[] =
  Object.values(AnalysisEtaUnavailableReason);

/**
 * What the caller says the parser is doing.
 *
 * A PARAMETER rather than something this module reads for itself, which keeps
 * the estimate free of collector coupling. Mapping guidance for whoever wires
 * it, including why the honest pause signal is `isParked()` and not
 * `isPaused()`, is recorded on ISS-8507 rather than guessed at here.
 *
 * `Stalled` is deliberately absent: a stall is DERIVED from measured silence,
 * never reported, because a wedged parser is exactly the one that cannot tell
 * anybody it is wedged.
 */
export const AnalysisParserActivity = {
  Running: "running",
  Paused: "paused",
  Failed: "failed",
} as const;
export type AnalysisParserActivity =
  (typeof AnalysisParserActivity)[keyof typeof AnalysisParserActivity];

/**
 * How much evidence stands behind a measured estimate.
 *
 * A statement about the sample window, not a product ranking, and NOT a
 * substitute for the floors that decide whether a number is stated at all -
 * labelling a thin number `provisional` is not the same as refusing to state it,
 * and the floors do the refusing.
 */
export const AnalysisEtaConfidence = {
  /** Past the floors, but the sample window is not yet full. */
  Provisional: "provisional",
  /** The sample window is full, so the rate rests on the most evidence kept. */
  Established: "established",
} as const;
export type AnalysisEtaConfidence =
  (typeof AnalysisEtaConfidence)[keyof typeof AnalysisEtaConfidence];

/** Bumped when the shape below changes in a way a consumer must notice. */
export const ANALYSIS_ETA_CONTRACT_VERSION = 1;

/**
 * Carried by every kind.
 *
 * `inventoryRevision` is on all four rather than on `measured` alone because an
 * estimate that arrives late is otherwise unattributable: a consumer holding a
 * revision-2 progress reading cannot tell whether a revision-1 estimate beside
 * it describes the same source set.
 */
type AnalysisEtaCommon = {
  contractVersion: typeof ANALYSIS_ETA_CONTRACT_VERSION;
  inventoryRevision: number;
};

export type MeasuredAnalysisEta = AnalysisEtaCommon & {
  kind: typeof AnalysisEtaKind.Measured;
  /** The SMOOTHED remaining time - what a countdown should read. */
  remainingMs: number;
  /** The unsmoothed derivation. Always `remainingBytes / throughputBytesPerMs`. */
  rawRemainingMs: number;
  remainingBytes: number;
  throughputBytesPerMs: number;
  confidence: AnalysisEtaConfidence;
  /** Samples the rate actually used, AFTER the outlier trim. */
  retainedSampleCount: number;
  /** Monotone total of measured active analysis time for this fold. */
  activeElapsedMs: number;
};

export type CalculatingAnalysisEta = AnalysisEtaCommon & {
  kind: typeof AnalysisEtaKind.Calculating;
  retainedSampleCount: number;
  activeElapsedMs: number;
};

export type UnavailableAnalysisEta = AnalysisEtaCommon & {
  kind: typeof AnalysisEtaKind.Unavailable;
  reason: AnalysisEtaUnavailableReason;
};

export type CompleteAnalysisEta = AnalysisEtaCommon & {
  kind: typeof AnalysisEtaKind.Complete;
};

export type TranscriptAnalysisEta =
  | MeasuredAnalysisEta
  | CalculatingAnalysisEta
  | UnavailableAnalysisEta
  | CompleteAnalysisEta;

/**
 * Every key ANY member can carry.
 *
 * Enumerating the members instead of writing `keyof TranscriptAnalysisEta`,
 * which yields only the keys common to ALL of them and would silently drop
 * every optional field from the coverage guard below - re-opening the drift the
 * guard exists to catch. Same shape, and the same reason, as
 * `MaintenanceProgressWireKey`.
 */
export type AnalysisEtaWireKey =
  | keyof MeasuredAnalysisEta
  | keyof CalculatingAnalysisEta
  | keyof UnavailableAnalysisEta
  | keyof CompleteAnalysisEta;

/**
 * The transported shape. Optional fields are OMITTED when the kind does not
 * carry them, never serialized as `null`: this crosses a process boundary to a
 * consumer that may be a version-skewed build, and the receiving contract does
 * not declare them nullable.
 */
export type AnalysisEtaWire = {
  contractVersion: number;
  inventoryRevision: number;
  kind: AnalysisEtaKind;
  reason?: AnalysisEtaUnavailableReason;
  remainingMs?: number;
  rawRemainingMs?: number;
  remainingBytes?: number;
  throughputBytesPerMs?: number;
  confidence?: AnalysisEtaConfidence;
  retainedSampleCount?: number;
  activeElapsedMs?: number;
};

/**
 * Compile-time proof that {@link AnalysisEtaWire} knows every key the union can
 * produce. A field added to a member fails `tsc` here until the wire shape and
 * the projection learn it, rather than being dropped in silence at the boundary.
 */
const ANALYSIS_ETA_WIRE_KEY_WITNESS: Record<AnalysisEtaWireKey, true> = {
  activeElapsedMs: true,
  confidence: true,
  contractVersion: true,
  inventoryRevision: true,
  kind: true,
  rawRemainingMs: true,
  reason: true,
  remainingBytes: true,
  remainingMs: true,
  retainedSampleCount: true,
  throughputBytesPerMs: true,
};

/** Every wire key, derived from the witness so the two cannot disagree. */
export const ANALYSIS_ETA_WIRE_KEYS = Object.keys(
  ANALYSIS_ETA_WIRE_KEY_WITNESS
) as readonly AnalysisEtaWireKey[];

/**
 * Project an estimate to its transported shape, omitting what the kind does not
 * carry.
 *
 * The `kind` discriminator is projected on every member, because it is the
 * whole mechanism by which a consumer tells the four states apart.
 */
export function toAnalysisEtaWire(eta: TranscriptAnalysisEta): AnalysisEtaWire {
  const base = {
    contractVersion: eta.contractVersion,
    inventoryRevision: eta.inventoryRevision,
    kind: eta.kind,
  };
  switch (eta.kind) {
    case AnalysisEtaKind.Measured:
      return {
        ...base,
        activeElapsedMs: eta.activeElapsedMs,
        confidence: eta.confidence,
        rawRemainingMs: eta.rawRemainingMs,
        remainingBytes: eta.remainingBytes,
        remainingMs: eta.remainingMs,
        retainedSampleCount: eta.retainedSampleCount,
        throughputBytesPerMs: eta.throughputBytesPerMs,
      };
    case AnalysisEtaKind.Calculating:
      return {
        ...base,
        activeElapsedMs: eta.activeElapsedMs,
        retainedSampleCount: eta.retainedSampleCount,
      };
    case AnalysisEtaKind.Unavailable:
      return { ...base, reason: eta.reason };
    case AnalysisEtaKind.Complete:
      return base;
    default: {
      const unreachable: never = eta;
      return unreachable;
    }
  }
}
