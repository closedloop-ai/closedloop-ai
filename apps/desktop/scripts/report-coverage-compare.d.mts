// Hand-maintained declarations for report-coverage-compare.mjs (ISS-4594) so
// the desktop node:test suite and the coverage lane consume it typed.
export declare const CompareOutcome: {
  Ok: "ok";
  Drop: "drop";
  Discontinuity: "discontinuity";
};
export type CompareOutcome =
  (typeof CompareOutcome)[keyof typeof CompareOutcome];

/** Ceiling on a single partition's churn allowance, in percentage points. */
export declare const MAX_CHURN_ALLOWANCE_PCT: number;

export type CompareDelta = {
  partition: string;
  basePct?: number;
  currentPct?: number;
  reason?: string;
};

export type CompareVerdict = {
  outcome: CompareOutcome;
  /** Real regressions — these fail the lane. */
  drops: CompareDelta[];
  /**
   * Percentage dips fully explained by something other than less testing — a
   * shrunken source universe, or a branch universe the node lane re-enumerated.
   */
  notes: CompareDelta[];
  detail: string;
};

/** The fields compare reads; both sides are real measurements of their tree. */
export type ComparablePartition = {
  branchPct: number;
  executedFiles: number;
  sourceFiles: number;
  /**
   * Optional because a base artifact published by an older revision of this
   * lane may not carry it; absent means "no churn allowance", i.e. stricter.
   */
  branchesTotal?: number;
  /**
   * Fingerprint of the partition's own PRODUCTION source tree. Optional for the
   * same reason, and absent is likewise treated as "not proven unchanged" — the
   * churn allowance is withheld rather than assumed.
   */
  sourceHash?: string;
};

/**
 * Run-level provenance the allowance needs on top of the per-partition source
 * hash. A test change moves a coverage number while leaving production source
 * byte-identical, so both sides must publish a matching test-tree fingerprint
 * before churn can explain anything.
 */
export type ComparisonProvenance = {
  currentTestTreeHash?: string;
  baseTestTreeHash?: string;
};

export declare const PartitionDeltaKind: {
  AtOrAbove: "at-or-above";
  UniverseShrank: "universe-shrank";
  BranchChurn: "branch-churn";
  Drop: "drop";
};
export type PartitionDeltaKind =
  (typeof PartitionDeltaKind)[keyof typeof PartitionDeltaKind];

export type PartitionDelta = {
  partition: string;
  basePct: number;
  currentPct: number;
  baseUnreached: number | null;
  currentUnreached: number | null;
  /** One side could not report file reach at all — unknown, not flat. */
  breadthUnknown: boolean;
  unreachedGrew: boolean;
  churnAllowancePct: number;
  pctKind: PartitionDeltaKind;
  pctReason: string | null;
};

export declare function methodIdentityEquals(a: unknown, b: unknown): boolean;

/**
 * The single decision both the compare step and the sticky PR comment render.
 */
export declare function classifyPartitionDelta(
  partitionName: string,
  current: ComparablePartition,
  baseEntry: ComparablePartition,
  provenance?: ComparisonProvenance
): PartitionDelta;

/**
 * Percentage points of a dip that branch-universe churn alone accounts for.
 * Zero unless the move is a PROVEN re-enumeration: identical totals, a
 * source-derived denominator, a partition whose source is not provably
 * unchanged, a test tree that is not provably unchanged, and an
 * absent/non-finite/non-positive total on either side all withhold the
 * allowance. Never exceeds `MAX_CHURN_ALLOWANCE_PCT`.
 */
export declare function branchChurnAllowancePct(
  current: { branchesTotal?: number; sourceHash?: string },
  baseEntry: { branchesTotal?: number; sourceHash?: string },
  partitionName?: string,
  provenance?: ComparisonProvenance
): number;

export declare function compareToBase(
  currentStats: Record<string, ComparablePartition>,
  currentMethod: unknown,
  base: {
    method: unknown;
    partitions: Record<string, ComparablePartition>;
    testTreeHash?: string;
  },
  currentTestTreeHash?: string
): CompareVerdict;
