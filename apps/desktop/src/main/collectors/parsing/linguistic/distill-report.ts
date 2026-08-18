/**
 * @file distill-report.ts
 * @description FEA-2274 (PRD-488): the PURE core of the offline distillation
 * measurement. Given each corpus session's classified segments (state +
 * confidence + attributed spend) and the prose inside each residual window, it
 * measures how much residual `other`/low-confidence spend carries a recognizable
 * natural-language signature — expressed as a COVERAGE UPLIFT via the FEA-2266
 * metric module (the SSOT), overall and per cohort — and tallies which
 * linguistic rules would capture it.
 *
 * HONEST UPPER BOUND: the "after" coverage assumes every matched relabel is
 * CORRECT and would be captured by a promoted deterministic rule. The corpus has
 * no per-segment activity ground-truth, so this measures *how much residual spend
 * is linguistically recognizable*, NOT that the labels are right. It is a
 * prioritization signal for which signatures deserve promotion into FEA-2269 — a
 * human judgment — never an automatic classifier change. The per-rule support
 * tallies (distinct sessions, spend) exist precisely so a one-session,
 * over-fitted cue is visible and not mistaken for a robust rule.
 *
 * Pure/in-memory: no DB, no fs, no model. Deterministic — identical input yields
 * a deep-equal report (the harness's reproducibility contract).
 */

import { microCentsToUsd, usdToMicroCents } from "../../../cost/cost-math.js";
import {
  type ActivityState,
  type ClassifiedSegment,
  CONFIDENT_MIN_BUCKET,
  type CoverageResult,
  type CoverageSession,
  computeCoverage,
  confidenceBucketFor,
  type SessionCohort,
} from "../../../telemetry/attribution-metrics.js";
import type { ActivityPhase } from "../activity-taxonomy.js";
import {
  detectLinguisticSignal,
  type LinguisticSignal,
} from "./linguistic-features.js";
import { isResidualSegment } from "./residual-selector.js";

/** One classified segment plus the prose inside its window (empty when none). */
export type DistillSegmentInput = {
  state: ActivityState;
  /** Raw classifier confidence (0..1). */
  confidence: number;
  /** USD spend attributed to this segment (≥ 0). */
  spendUsd: number;
  /** Natural-language text within this segment's window; scanned only if residual. */
  prose: string;
};

/** One corpus session's classified segments + cohort tags + out-of-segment gap spend. */
export type DistillSessionInput = {
  sessionId: string;
  cohort: SessionCohort;
  segments: readonly DistillSegmentInput[];
  /** Spend in turns covered by no segment (implicit `other`); counts toward total. */
  gapSpendUsd: number;
};

/** Per-rule support: how broadly and how much residual spend a signature would capture. */
export type RuleSupport = {
  ruleId: string;
  phase: ActivityPhase;
  cue: string;
  /** Distinct sessions the rule fired in (breadth — the anti-over-fitting signal). */
  sessions: number;
  /** Residual segments the rule matched. */
  segments: number;
  /** Residual spend (USD) the rule would move into a covered bucket (upper bound). */
  residualSpendUsd: number;
};

export type DistillationReport = {
  sessionCount: number;
  segmentCount: number;
  residualSegmentCount: number;
  totalSpendUsd: number;
  residualSpendUsd: number;
  /** Residual spend carrying a recognized linguistic signature (upper-bound capturable). */
  matchedResidualSpendUsd: number;
  before: CoverageResult;
  after: CoverageResult;
  /** after.overall.coverage − before.overall.coverage (the headline uplift). */
  overallCoverageUplift: number;
  /** Proposed rules, most residual spend first (deterministic tiebreak on id). */
  proposedRules: RuleSupport[];
};

type RuleTally = {
  phase: ActivityPhase;
  cue: string;
  sessions: Set<string>;
  segments: number;
  /** Residual spend in integer micro-cents (exact — mirrors the Coverage sum). */
  residualSpendMicro: number;
};

// Spend is accumulated in integer MICRO-CENTS (never float), the same convention
// `computeCoverage` uses, so the report's `totalSpendUsd`/`residualSpendUsd`
// reconcile exactly with the Coverage totals instead of drifting a few
// micro-cents on float accumulation.
type Stats = {
  segments: number;
  residualSegments: number;
  totalMicro: number;
  residualMicro: number;
  matchedMicro: number;
};

function toClassified(segment: DistillSegmentInput): ClassifiedSegment {
  return {
    state: segment.state,
    confidence: confidenceBucketFor(segment.confidence),
    spendUsd: segment.spendUsd,
  };
}

/** A residual segment relabeled to its signal phase at the confident floor. */
function relabeled(
  segment: DistillSegmentInput,
  phase: ActivityPhase
): ClassifiedSegment {
  return {
    state: phase,
    confidence: CONFIDENT_MIN_BUCKET,
    spendUsd: segment.spendUsd,
  };
}

function recordTally(
  tallies: Map<string, RuleTally>,
  signal: LinguisticSignal,
  sessionId: string,
  spendUsd: number
): void {
  const existing = tallies.get(signal.ruleId);
  const tally: RuleTally = existing ?? {
    phase: signal.phase,
    cue: signal.cue,
    sessions: new Set<string>(),
    segments: 0,
    residualSpendMicro: 0,
  };
  tally.sessions.add(sessionId);
  tally.segments += 1;
  tally.residualSpendMicro += usdToMicroCents(spendUsd);
  if (!existing) {
    tallies.set(signal.ruleId, tally);
  }
}

function finalizeTallies(tallies: Map<string, RuleTally>): RuleSupport[] {
  const rules: RuleSupport[] = [];
  for (const [ruleId, tally] of tallies) {
    rules.push({
      ruleId,
      phase: tally.phase,
      cue: tally.cue,
      sessions: tally.sessions.size,
      segments: tally.segments,
      residualSpendUsd: microCentsToUsd(tally.residualSpendMicro),
    });
  }
  rules.sort((a, b) => {
    if (b.residualSpendUsd !== a.residualSpendUsd) {
      return b.residualSpendUsd - a.residualSpendUsd;
    }
    return a.ruleId < b.ruleId ? -1 : 1;
  });
  return rules;
}

/** Split one session into its before/after coverage inputs, updating tallies+stats. */
function processSession(
  session: DistillSessionInput,
  tallies: Map<string, RuleTally>,
  stats: Stats
): { before: CoverageSession; after: CoverageSession } {
  const beforeSegs: ClassifiedSegment[] = [];
  const afterSegs: ClassifiedSegment[] = [];
  for (const seg of session.segments) {
    stats.segments += 1;
    stats.totalMicro += usdToMicroCents(seg.spendUsd);
    beforeSegs.push(toClassified(seg));
    const residual = isResidualSegment({
      phase: seg.state,
      confidence: seg.confidence,
    });
    const signal = residual ? detectLinguisticSignal(seg.prose) : null;
    if (residual) {
      stats.residualSegments += 1;
      stats.residualMicro += usdToMicroCents(seg.spendUsd);
    }
    if (signal) {
      stats.matchedMicro += usdToMicroCents(seg.spendUsd);
      recordTally(tallies, signal, session.sessionId, seg.spendUsd);
      afterSegs.push(relabeled(seg, signal.phase));
    } else {
      afterSegs.push(toClassified(seg));
    }
  }
  stats.totalMicro += usdToMicroCents(session.gapSpendUsd);
  const shared = { cohort: session.cohort, gapSpendUsd: session.gapSpendUsd };
  return {
    before: { sessionId: session.sessionId, segments: beforeSegs, ...shared },
    after: { sessionId: session.sessionId, segments: afterSegs, ...shared },
  };
}

/**
 * Measure residual-coverage uplift and the linguistic rules that drive it across
 * the corpus. The single entry point the offline harness calls.
 */
export function buildDistillationReport(
  sessions: readonly DistillSessionInput[]
): DistillationReport {
  const before: CoverageSession[] = [];
  const after: CoverageSession[] = [];
  const tallies = new Map<string, RuleTally>();
  const stats: Stats = {
    segments: 0,
    residualSegments: 0,
    totalMicro: 0,
    residualMicro: 0,
    matchedMicro: 0,
  };

  for (const session of sessions) {
    const split = processSession(session, tallies, stats);
    before.push(split.before);
    after.push(split.after);
  }

  const beforeCoverage = computeCoverage(before);
  const afterCoverage = computeCoverage(after);

  return {
    sessionCount: sessions.length,
    segmentCount: stats.segments,
    residualSegmentCount: stats.residualSegments,
    totalSpendUsd: microCentsToUsd(stats.totalMicro),
    residualSpendUsd: microCentsToUsd(stats.residualMicro),
    matchedResidualSpendUsd: microCentsToUsd(stats.matchedMicro),
    before: beforeCoverage,
    after: afterCoverage,
    overallCoverageUplift:
      afterCoverage.overall.coverage - beforeCoverage.overall.coverage,
    proposedRules: finalizeTallies(tallies),
  };
}
