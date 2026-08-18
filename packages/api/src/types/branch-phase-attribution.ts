/** Consumer-visible Branch lifecycle phases. Internal classifier labels are excluded. */
export const BranchVisibleLifecyclePhase = {
  Build: "build",
  Review: "review",
  Rework: "rework",
} as const;
export type BranchVisibleLifecyclePhase =
  (typeof BranchVisibleLifecyclePhase)[keyof typeof BranchVisibleLifecyclePhase];

/** Truthfulness state for the canonical segment-level phase projection. */
export const BranchPhaseAttributionCompleteness = {
  Complete: "complete",
  Partial: "partial",
  Unavailable: "unavailable",
} as const;
export type BranchPhaseAttributionCompleteness =
  (typeof BranchPhaseAttributionCompleteness)[keyof typeof BranchPhaseAttributionCompleteness];

/** Closed reasons why a phase projection cannot claim complete coverage. */
export const BranchPhaseAttributionCompletenessReason = {
  MalformedEvidence: "malformed_evidence",
  CoverageCapped: "coverage_capped",
  AmbiguousEvidence: "ambiguous_evidence",
  LifecycleIncomplete: "lifecycle_incomplete",
  PricingIncomplete: "pricing_incomplete",
  MissingActivitySegments: "missing_activity_segments",
} as const;
export type BranchPhaseAttributionCompletenessReason =
  (typeof BranchPhaseAttributionCompletenessReason)[keyof typeof BranchPhaseAttributionCompletenessReason];

/** One priced activity segment projected exactly once into a visible phase. */
export type BranchPhaseAttributionSegment = {
  sessionId: string;
  sequence: number;
  phase: BranchVisibleLifecyclePhase;
  startMs: number;
  endMs: number;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  evidenceIds: readonly string[];
  /** Global Branch divisor applied to this Session's phase subtotal. */
  qualifyingBranchCount?: number;
  /** Raw event-time costs retained for list metric windowing. */
  costEvents?: readonly {
    sourceEventId: string;
    occurredAtMs: number;
    costUsd: number;
  }[];
};

/** Additive phase total plus unioned wall-clock duration. */
export type BranchPhaseAttributionRollup = {
  phase: BranchVisibleLifecyclePhase;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  sessionCount: number;
};

export type BranchPhaseAttributionCoverage =
  | {
      completeness: typeof BranchPhaseAttributionCompleteness.Complete;
      subtotalUsd: number;
    }
  | {
      completeness: typeof BranchPhaseAttributionCompleteness.Partial;
      reason: BranchPhaseAttributionCompletenessReason;
      subtotalUsd: number;
    }
  | {
      completeness: typeof BranchPhaseAttributionCompleteness.Unavailable;
      reason: BranchPhaseAttributionCompletenessReason;
    };

/** Canonical additive Branch attribution output shared by cloud and Desktop. */
export type BranchPhaseAttributionResult = {
  segments: readonly BranchPhaseAttributionSegment[];
  rollups: readonly BranchPhaseAttributionRollup[];
  coverage: BranchPhaseAttributionCoverage;
};
