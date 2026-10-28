/**
 * @file attribution-metrics.ts
 * @description FEA-2266 (PRD-488): the PURE, importable SSOT for activity-
 * attribution metrics. It defines the activity taxonomy, the confidence buckets,
 * the cohort axes + band cut-points, and computes **Coverage** — the share of a
 * session's spend a classifier confidently attributed to a REAL activity (not
 * `other`/`idle`) — overall and sliced by cohort. NO DB, NO fs, NO IPC, NO
 * Electron, NO Zod: a deterministic, total function library (mirrors the
 * `cost-math.ts` pure-module style). It also provides the pure per-segment spend
 * attribution (`token_events` → segment $) that the Coverage inputs are built
 * from, so FEA-2273's in-product read imports one module end to end.
 *
 * THIS MODULE IS THE CONTRACT FEA-2273 (in-product metrics) IMPORTS UNCHANGED —
 * the taxonomy/confidence/cohort const-objects AND the band cut-points.
 * Downstream features import these; they never re-define them. ISS-10721 moved
 * the autonomy band, its cut-points and its mapping to `@repo/api` so the cloud
 * twin classifies identically; they are re-exported here, so that contract is
 * unchanged for every importer.
 *
 * Coverage = Σ(spend in a confident, non-`other`, non-`idle` segment)
 *            / Σ(total session spend). Coverage runs on the classifier's OWN
 * output (state + confidence per segment) — it needs no human ground truth.
 * Spend is summed in integer micro-cents (reusing `cost-math.ts`) so the
 * numerator/denominator are EXACT integer aggregates, not float accumulations.
 */

import {
  type AutonomyBand,
  SpendConfidenceTier,
} from "@repo/api/src/types/session-activity-metrics";
import type { Harness } from "../collectors/types.js";
import { microCentsToUsd, usdToMicroCents } from "../cost/cost-math.js";

// ── Taxonomy (Q-001: validated against the corpus; versioned) ────────────────

/**
 * The v1 activity taxonomy the classifier (FEA-2269) assigns per segment. The
 * first seven are the PRD attribution types; `idle` is the spend-free
 * no-activity state (idle handling per the FEA-2267 segment contract). A change
 * here is a deliberate, versioned act — bump {@link TAXONOMY_VERSION}.
 */
export const ActivityState = {
  Explore: "explore",
  Plan: "plan",
  Implement: "implement",
  Review: "review",
  Validate: "validate",
  Rework: "rework",
  Other: "other",
  Idle: "idle",
} as const;
export type ActivityState = (typeof ActivityState)[keyof typeof ActivityState];

/** Canonical ordered member list — the SSOT for schema validation + the drift guard. */
export const ACTIVITY_STATE_VALUES = [
  ActivityState.Explore,
  ActivityState.Plan,
  ActivityState.Implement,
  ActivityState.Review,
  ActivityState.Validate,
  ActivityState.Rework,
  ActivityState.Other,
  ActivityState.Idle,
] as const satisfies readonly ActivityState[];

/** Bumped when the taxonomy's member set or semantics change (Q-001). */
export const TAXONOMY_VERSION = 1;

/**
 * States that NEVER count as covered spend, by construction: `other`
 * (unclassifiable) and `idle` (no work). `idle` carries ~zero spend, but a
 * confident `idle` segment must never inflate Coverage — so it is excluded from
 * the numerator exactly like `other`.
 */
export const COVERAGE_EXCLUDED_STATES: ReadonlySet<ActivityState> = new Set([
  ActivityState.Other,
  ActivityState.Idle,
]);

// ── Confidence buckets (Q-003: thresholds finalized against the corpus) ───────

/**
 * The discrete confidence buckets a classifier's segment confidence is binned
 * into.
 *
 * ISS-10721 made `SpendConfidenceTier`
 * (`@repo/api/src/types/session-activity-metrics`) the owner of these members,
 * because the cloud twin of the spend split names the same three tiers and two
 * copies would let a renamed or added bucket mean different things on the two
 * sides of the sync. Aliased back to `ConfidenceBucket` here so every desktop
 * call site, the cut-points and the confident threshold below are unchanged.
 */
export const ConfidenceBucket = SpendConfidenceTier;
export type ConfidenceBucket = SpendConfidenceTier;

/** Ordered low → high; the index is the bucket rank used by the confident threshold. */
export const CONFIDENCE_BUCKET_VALUES = [
  ConfidenceBucket.Low,
  ConfidenceBucket.Medium,
  ConfidenceBucket.High,
] as const satisfies readonly ConfidenceBucket[];

/**
 * PROVISIONAL numeric cut-points mapping a 0..1 confidence to a bucket, the only
 * place they may be edited (Q-003 finalizes them against the corpus). Buckets:
 * low = [0, lowMaxExclusive), medium = [lowMaxExclusive, highMinInclusive),
 * high = [highMinInclusive, 1].
 */
export const CONFIDENCE_BUCKET_CUTPOINTS = {
  lowMaxExclusive: 0.5,
  highMinInclusive: 0.85,
} as const;

/**
 * PROVISIONAL "confident" threshold (Q-003): a segment counts toward Coverage
 * only at this bucket or higher. Exposed as a named constant so it cannot drift
 * between this feature and FEA-2273.
 */
export const CONFIDENT_MIN_BUCKET: ConfidenceBucket = ConfidenceBucket.Medium;

/** Bin a 0..1 confidence into a bucket. Out-of-range values clamp to the ends. */
export function confidenceBucketFor(value: number): ConfidenceBucket {
  if (value < CONFIDENCE_BUCKET_CUTPOINTS.lowMaxExclusive) {
    return ConfidenceBucket.Low;
  }
  if (value < CONFIDENCE_BUCKET_CUTPOINTS.highMinInclusive) {
    return ConfidenceBucket.Medium;
  }
  return ConfidenceBucket.High;
}

/** True when `bucket` is at or above the confident threshold (Q-003). */
export function isConfident(bucket: ConfidenceBucket): boolean {
  return (
    CONFIDENCE_BUCKET_VALUES.indexOf(bucket) >=
    CONFIDENCE_BUCKET_VALUES.indexOf(CONFIDENT_MIN_BUCKET)
  );
}

// ── Cohort axes + band cut-points (the shared home; tied to Q-003) ────────────

/*
 * The autonomy bands, their cut-points, and the index -> band mapping used to
 * live here. ISS-10721 moved all three to
 * `@repo/api/src/types/session-activity-metrics`, because the cloud twin of
 * `session_activity_metrics` must bucket the same index into the same band — a
 * second copy here would let the local rollup and its cloud reader disagree
 * about what "agentic" means. Consumers import them from that module directly;
 * re-exporting them through this one is a barrel file (`noBarrelFile`), and the
 * repo's rule for a moved symbol is a direct subpath import at each call site.
 */

/** Session-length bands, derived from the rollup's `runtime_ms`. */
export const LengthBand = {
  Short: "short",
  Medium: "medium",
  Long: "long",
} as const;
export type LengthBand = (typeof LengthBand)[keyof typeof LengthBand];

/**
 * PROVISIONAL session-length band boundaries in milliseconds (Q-003) — the only
 * place they may be edited.
 *  short  = [0, shortMaxMsExclusive)
 *  medium = [shortMaxMsExclusive, longMinMsInclusive)
 *  long   = [longMinMsInclusive, ∞)
 */
export const SESSION_LENGTH_BAND_CUTPOINTS = {
  shortMaxMsExclusive: 5 * 60_000,
  longMinMsInclusive: 30 * 60_000,
} as const;

/** Map a session runtime (ms) to its length band using the shared cut-points. */
export function sessionLengthBandFor(runtimeMs: number): LengthBand {
  if (runtimeMs < SESSION_LENGTH_BAND_CUTPOINTS.shortMaxMsExclusive) {
    return LengthBand.Short;
  }
  if (runtimeMs < SESSION_LENGTH_BAND_CUTPOINTS.longMinMsInclusive) {
    return LengthBand.Medium;
  }
  return LengthBand.Long;
}

/** The cohort axes Coverage is sliced by (PLN-1196 minimum set). */
export const CohortAxis = {
  Harness: "harness",
  AutonomyBand: "autonomy_band",
  ClosedloopUser: "closedloop_user",
  LengthBand: "length_band",
} as const;
export type CohortAxis = (typeof CohortAxis)[keyof typeof CohortAxis];

export const COHORT_AXIS_VALUES = [
  CohortAxis.Harness,
  CohortAxis.AutonomyBand,
  CohortAxis.ClosedloopUser,
  CohortAxis.LengthBand,
] as const satisfies readonly CohortAxis[];

/** Bucket value an unknown/unrecorded harness lands in on the harness axis. */
export const UNKNOWN_HARNESS_KEY = "unknown";

/** A cell with fewer than this many sessions is flagged low-sample, not trusted. */
export const MIN_COHORT_CELL_SESSIONS = 3;

// ── Inputs ───────────────────────────────────────────────────────────────────

/** A classified segment — the classifier's state + confidence — with its spend. */
export type ClassifiedSegment = {
  state: ActivityState;
  confidence: ConfidenceBucket;
  /** USD spend attributed to this segment from `token_events` (≥ 0). */
  spendUsd: number;
};

/** The per-session cohort tags (precomputed by the sampler from the store). */
export type SessionCohort = {
  /** null when the harness is unrecorded/unknown. */
  harness: Harness | null;
  autonomyBand: AutonomyBand;
  closedloopUser: boolean;
  lengthBand: LengthBand;
};

/** One session's classified segments + cohort, the unit Coverage aggregates. */
export type CoverageSession = {
  sessionId: string;
  cohort: SessionCohort;
  segments: readonly ClassifiedSegment[];
  /**
   * Spend (USD) in turns covered by NO segment — implicit `other`. It counts
   * toward TOTAL spend but is never covered, so omitting it would shrink the
   * denominator and overstate Coverage. Defaults to 0 (a fully-tiled session has
   * no gap). The caller computes it from `token_events` (see
   * {@link attributeSegmentSpendUsd} below).
   */
  gapSpendUsd?: number;
};

// ── Outputs ──────────────────────────────────────────────────────────────────

export type CoverageCell = {
  /** Covered = confident, non-`other`, non-`idle`. */
  coveredSpendUsd: number;
  totalSpendUsd: number;
  /** coveredSpendUsd / totalSpendUsd; 0 when there is no spend (guarded). */
  coverage: number;
  sessionCount: number;
  /** True when sessionCount < {@link MIN_COHORT_CELL_SESSIONS} (too little data). */
  lowSample: boolean;
};

export type CoverageResult = {
  overall: CoverageCell;
  byCohort: Record<CohortAxis, Record<string, CoverageCell>>;
};

/**
 * Bumped when the Coverage output shape/semantics change.
 *
 * FEA-2273's persisted rollup stamps this into
 * `session_activity_metrics.metric_version`, and its boot backfill re-selects
 * every row stamped BELOW it — so bumping this constant is the MECHANISM that
 * forces persisted rows to be recomputed under the new math. Before ISS-6759 the
 * stamp did not exist and this docstring claimed a gate nothing implemented, so a
 * bump changed the formula for new rows only and left old ones untouched.
 *
 * Bumping it is an OBLIGATION, not just this module's privilege. The persisted
 * Coverage numbers are produced by this module's math AND by the adapter's own
 * derivations in `database/activity-metrics.ts` — the gap-spend split, the
 * micro-cent confidence tiers, `coveredSegmentCount`, and the `created_at` filter
 * that decides which spend reaches the denominator. Any of those changing what a
 * row would compute to is a formula change for stamping purposes and must bump
 * this constant, or the same silent-mixed-formula gap reopens on the other side
 * of the boundary.
 *
 * It is deliberately SEPARATE from the segment classifier version: that one
 * tracks the INPUTS (a re-tile), this one tracks the MATH over them, and a change
 * to either alone must re-derive.
 */
export const ATTRIBUTION_METRIC_VERSION = 1;

// ── Internal ─────────────────────────────────────────────────────────────────

type CoverageAccum = {
  coveredMicro: number;
  totalMicro: number;
  sessions: number;
};

/**
 * The cohort bucket key a session falls into on a given axis.
 *
 * ISS-6758: exported because the FR-12 cohort READ
 * (`database/activity-coverage-read.ts`) re-aggregates the PERSISTED per-session
 * rows rather than raw segments, so it must land each row in the same bucket
 * this function would. Deriving those keys in SQL (a `COALESCE(harness,
 * 'unknown')`, a `CASE closedloop_user`) would be a second copy of the mapping,
 * free to drift from this one silently — the read imports it instead.
 */
export function cohortValue(axis: CohortAxis, cohort: SessionCohort): string {
  switch (axis) {
    case CohortAxis.Harness:
      return cohort.harness ?? UNKNOWN_HARNESS_KEY;
    case CohortAxis.AutonomyBand:
      return cohort.autonomyBand;
    case CohortAxis.ClosedloopUser:
      return cohort.closedloopUser ? "closedloop" : "external";
    case CohortAxis.LengthBand:
      return cohort.lengthBand;
    default:
      return assertNever(axis);
  }
}

/** Compile-time exhaustiveness guard: a new union member fails to build here. */
function assertNever(value: never): never {
  throw new Error(`unhandled cohort axis: ${String(value)}`);
}

/** True when a classified segment contributes to covered spend. */
function isCoveredSegment(segment: ClassifiedSegment): boolean {
  return (
    isConfident(segment.confidence) &&
    !COVERAGE_EXCLUDED_STATES.has(segment.state)
  );
}

function getOrCreate<T>(map: Map<string, T>, key: string, make: () => T): T {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }
  const created = make();
  map.set(key, created);
  return created;
}

function emptyAxisMaps<T>(): Record<CohortAxis, Map<string, T>> {
  const out = {} as Record<CohortAxis, Map<string, T>>;
  for (const axis of COHORT_AXIS_VALUES) {
    out[axis] = new Map<string, T>();
  }
  return out;
}

function finalizeAxisMaps<TIn, TOut>(
  maps: Record<CohortAxis, Map<string, TIn>>,
  finalize: (value: TIn) => TOut
): Record<CohortAxis, Record<string, TOut>> {
  const out = {} as Record<CohortAxis, Record<string, TOut>>;
  for (const axis of COHORT_AXIS_VALUES) {
    const record: Record<string, TOut> = {};
    for (const [key, value] of [...maps[axis].entries()].sort(byKey)) {
      record[key] = finalize(value);
    }
    out[axis] = record;
  }
  return out;
}

function byKey<T>(a: [string, T], b: [string, T]): number {
  if (a[0] < b[0]) {
    return -1;
  }
  if (a[0] > b[0]) {
    return 1;
  }
  return 0;
}

// ── Coverage ─────────────────────────────────────────────────────────────────

function addCoverage(accum: CoverageAccum, session: CoverageSession): void {
  accum.sessions += 1;
  for (const segment of session.segments) {
    const micro = usdToMicroCents(segment.spendUsd);
    accum.totalMicro += micro;
    if (isCoveredSegment(segment)) {
      accum.coveredMicro += micro;
    }
  }
  // Gap spend (turns in no segment) is implicit `other`: it counts toward the
  // denominator but is never covered.
  accum.totalMicro += usdToMicroCents(session.gapSpendUsd ?? 0);
}

/**
 * Close one cell's integer micro-cent totals into a {@link CoverageCell}: the
 * exact ratio, its NaN-free zero guard, and the {@link MIN_COHORT_CELL_SESSIONS}
 * low-sample rule.
 *
 * ISS-6758: exported so the FR-12 cohort READ, which re-aggregates the PERSISTED
 * per-session rows instead of raw segments, closes its cells through the same
 * three rules. Only the ACCUMULATION differs between the two callers (segments
 * here, stored per-session sums there); a cell that divided or flagged
 * low-sample differently would be a second Coverage definition.
 */
export function coverageCellFromMicro(
  coveredMicro: number,
  totalMicro: number,
  sessionCount: number
): CoverageCell {
  return {
    coveredSpendUsd: microCentsToUsd(coveredMicro),
    totalSpendUsd: microCentsToUsd(totalMicro),
    coverage: totalMicro === 0 ? 0 : coveredMicro / totalMicro,
    sessionCount,
    lowSample: sessionCount < MIN_COHORT_CELL_SESSIONS,
  };
}

function finalizeCoverage(accum: CoverageAccum): CoverageCell {
  return coverageCellFromMicro(
    accum.coveredMicro,
    accum.totalMicro,
    accum.sessions
  );
}

/**
 * Coverage overall and per cohort. Spend is aggregated in integer micro-cents so
 * the ratio is exact; an empty corpus / all-`other` / zero-spend input yields a
 * defined, NaN-free zero result (the metric module is total).
 */
export function computeCoverage(
  sessions: readonly CoverageSession[]
): CoverageResult {
  const overall: CoverageAccum = {
    coveredMicro: 0,
    totalMicro: 0,
    sessions: 0,
  };
  const byAxis = emptyAxisMaps<CoverageAccum>();
  for (const session of sessions) {
    addCoverage(overall, session);
    for (const axis of COHORT_AXIS_VALUES) {
      const cell = getOrCreate(
        byAxis[axis],
        cohortValue(axis, session.cohort),
        () => ({ coveredMicro: 0, totalMicro: 0, sessions: 0 })
      );
      addCoverage(cell, session);
    }
  }
  return {
    overall: finalizeCoverage(overall),
    byCohort: finalizeAxisMaps(byAxis, finalizeCoverage),
  };
}

// ── Spend attribution (pure) ──────────────────────────────────────────────────

/** A per-turn spend event distilled from a `token_events` row. */
export type TokenSpendEvent = {
  /** ISO `created_at`; same format as a segment span (lexically ordered). */
  createdAt: string;
  /** `cost_usd_estimated` for the turn (0 when null/unknown). */
  costUsd: number;
};

/** The minimal time span a segment needs for spend attribution. */
export type SpendSegmentSpan = {
  /** ISO start; half-open `[startTs, endTs)`. */
  startTs: string;
  endTs: string;
};

/** Index of the segment whose half-open `[startTs, endTs)` covers `ts`, or -1. */
function segmentIndexAt(
  segments: readonly SpendSegmentSpan[],
  ts: string
): number {
  for (let i = 0; i < segments.length; i += 1) {
    if (ts >= segments[i].startTs && ts < segments[i].endTs) {
      return i;
    }
  }
  return -1;
}

/**
 * Per-segment USD spend: each turn's `token_events` cost is attributed to the
 * segment whose `[startTs, endTs)` contains the turn's `created_at`. Summed in
 * integer micro-cents (cost-math) so the per-segment totals are exact. Spend in
 * turns covered by no segment is dropped here — the caller derives gap spend as
 * `sessionTotalSpendUsd − Σ(per-segment)` (see {@link CoverageSession.gapSpendUsd}).
 */
export function attributeSegmentSpendUsd(
  events: readonly TokenSpendEvent[],
  segments: readonly SpendSegmentSpan[]
): number[] {
  const micro = segments.map(() => 0);
  for (const event of events) {
    const index = segmentIndexAt(segments, event.createdAt);
    if (index >= 0) {
      micro[index] += usdToMicroCents(event.costUsd);
    }
  }
  return micro.map(microCentsToUsd);
}

/** Total session spend (USD), exact via micro-cent summation. */
export function sessionTotalSpendUsd(
  events: readonly TokenSpendEvent[]
): number {
  let micro = 0;
  for (const event of events) {
    micro += usdToMicroCents(event.costUsd);
  }
  return microCentsToUsd(micro);
}
