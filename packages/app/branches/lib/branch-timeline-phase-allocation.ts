import type { BranchActivitySegment } from "@repo/api/src/types/branch";
import {
  UNATTRIBUTED_KEY as ACTIVITY_UNATTRIBUTED_KEY,
  BRANCH_ACTIVITY_ORDER,
} from "@repo/lib/branches/activity-rollup";
import { getActivityPhaseDisplay } from "./activity-taxonomy-display";

/**
 * How one timeline column's spend is split across the activity PHASES that ran
 * inside it — the "Activity phase" cut of the Branch timeline's group-by.
 *
 * Extracted from `branch-session-buckets.ts`, which owns the bucketing itself.
 * The two are separate responsibilities: that module decides WHICH column a
 * contribution lands in, this one decides how a contribution already assigned to
 * a column is divided once inside it.
 */

export type PhaseAllocation = {
  cacheWeight: number;
  costWeight: number;
  key: string;
  label: string;
  inputWeight: number;
  outputWeight: number;
  color: string;
  phase: string;
  sortRank: number;
};

type PhaseEvidence = {
  cache: number;
  cost: number;
  input: number;
  ms: number;
  output: number;
};

type PhaseMetric = Exclude<keyof PhaseEvidence, "ms">;

const PHASE_KEY_PREFIX = "phase:";

const ACTIVITY_PHASE_RANKS: ReadonlyMap<string, number> = new Map(
  BRANCH_ACTIVITY_ORDER.map((phase, index) => [phase, index])
);

export function phaseAllocationsForWindow(
  segments: readonly BranchActivitySegment[] | undefined,
  windowStart: number,
  windowEnd: number
): PhaseAllocation[] {
  const windowMs = Math.max(1, windowEnd - windowStart);
  if (!segments || segments.length === 0) {
    return [
      phaseAllocation(ACTIVITY_UNATTRIBUTED_KEY, {
        cacheWeight: 1,
        costWeight: 1,
        inputWeight: 1,
        outputWeight: 1,
      }),
    ];
  }

  const evidenceByPhase = new Map<string, PhaseEvidence>();
  let coveredMs = 0;
  for (const segment of segments) {
    const start = Math.max(windowStart, segment.startMs);
    const end = Math.min(windowEnd, segment.endMs);
    const overlap = end - start;
    if (overlap <= 0) {
      continue;
    }
    const phase = normalizeActivityPhase(segment.phase);
    addPhaseEvidence(evidenceByPhase, phase, segment, overlap);
    coveredMs += overlap;
  }
  if (coveredMs < windowMs) {
    addPhaseMsEvidence(
      evidenceByPhase,
      ACTIVITY_UNATTRIBUTED_KEY,
      windowMs - coveredMs
    );
  }

  const fallbackWeights = phaseMetricWeights(evidenceByPhase, "ms");
  const costWeights = phaseWeightsOrFallback(
    phaseMetricWeights(evidenceByPhase, "cost"),
    fallbackWeights
  );
  const inputWeights = phaseWeightsOrFallback(
    phaseMetricWeights(evidenceByPhase, "input"),
    fallbackWeights
  );
  const outputWeights = phaseWeightsOrFallback(
    phaseMetricWeights(evidenceByPhase, "output"),
    fallbackWeights
  );
  const cacheWeights = phaseWeightsOrFallback(
    phaseMetricWeights(evidenceByPhase, "cache"),
    fallbackWeights
  );
  return collectPhaseKeys([
    costWeights,
    inputWeights,
    outputWeights,
    cacheWeights,
  ])
    .map((phase) =>
      phaseAllocation(phase, {
        cacheWeight: cacheWeights.get(phase) ?? 0,
        costWeight: costWeights.get(phase) ?? 0,
        inputWeight: inputWeights.get(phase) ?? 0,
        outputWeight: outputWeights.get(phase) ?? 0,
      })
    )
    .filter(
      (allocation) =>
        allocation.cacheWeight > 0 ||
        allocation.costWeight > 0 ||
        allocation.inputWeight > 0 ||
        allocation.outputWeight > 0
    )
    .sort((left, right) => {
      const byRank = left.sortRank - right.sortRank;
      return byRank === 0 ? left.phase.localeCompare(right.phase) : byRank;
    });
}

function phaseAllocation(
  phase: string,
  weights: Pick<
    PhaseAllocation,
    "cacheWeight" | "costWeight" | "inputWeight" | "outputWeight"
  >
): PhaseAllocation {
  const display = getActivityPhaseDisplay(phase);
  return {
    cacheWeight: weights.cacheWeight,
    color: display.color,
    costWeight: weights.costWeight,
    key: `${PHASE_KEY_PREFIX}${phase}`,
    label: display.label,
    inputWeight: weights.inputWeight,
    outputWeight: weights.outputWeight,
    phase,
    sortRank: phaseSortRank(phase),
  };
}

function normalizeActivityPhase(phase: string): string {
  return phase.trim().toLowerCase() || "other";
}

function phaseSortRank(phase: string): number {
  if (phase === ACTIVITY_UNATTRIBUTED_KEY) {
    return BRANCH_ACTIVITY_ORDER.length + 1;
  }
  return ACTIVITY_PHASE_RANKS.get(phase) ?? BRANCH_ACTIVITY_ORDER.length;
}

function addPhaseEvidence(
  evidenceByPhase: Map<string, PhaseEvidence>,
  phase: string,
  segment: BranchActivitySegment,
  overlapMs: number
): void {
  const durationMs = Math.max(1, segment.endMs - segment.startMs);
  const overlapRatio = overlapMs / durationMs;
  const evidence = phaseEvidenceFor(evidenceByPhase, phase);
  evidence.ms += overlapMs;
  evidence.cost += positiveMetric(segment.costUsd) * overlapRatio;
  evidence.input += positiveMetric(segment.inputTokens) * overlapRatio;
  evidence.output += positiveMetric(segment.outputTokens) * overlapRatio;
  evidence.cache +=
    (positiveMetric(segment.cacheReadTokens) +
      positiveMetric(segment.cacheWriteTokens)) *
    overlapRatio;
}

function addPhaseMsEvidence(
  evidenceByPhase: Map<string, PhaseEvidence>,
  phase: string,
  ms: number
): void {
  phaseEvidenceFor(evidenceByPhase, phase).ms += ms;
}

function phaseEvidenceFor(
  evidenceByPhase: Map<string, PhaseEvidence>,
  phase: string
): PhaseEvidence {
  const existing = evidenceByPhase.get(phase);
  if (existing) {
    return existing;
  }
  const evidence = { cache: 0, cost: 0, input: 0, ms: 0, output: 0 };
  evidenceByPhase.set(phase, evidence);
  return evidence;
}

function phaseMetricWeights(
  evidenceByPhase: Map<string, PhaseEvidence>,
  metric: PhaseMetric | "ms"
): Map<string, number> {
  const total = [...evidenceByPhase.values()].reduce(
    (sum, evidence) => sum + evidence[metric],
    0
  );
  if (total <= 0) {
    return new Map();
  }
  return new Map(
    [...evidenceByPhase.entries()]
      .map(([phase, evidence]) => [phase, evidence[metric] / total] as const)
      .filter((entry) => entry[1] > 0)
  );
}

function phaseWeightsOrFallback(
  weights: Map<string, number>,
  fallbackWeights: Map<string, number>
): Map<string, number> {
  return weights.size > 0 ? weights : fallbackWeights;
}

function collectPhaseKeys(
  weightMaps: readonly Map<string, number>[]
): string[] {
  const phases = new Set<string>();
  for (const weights of weightMaps) {
    for (const phase of weights.keys()) {
      phases.add(phase);
    }
  }
  return [...phases];
}

function positiveMetric(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}
