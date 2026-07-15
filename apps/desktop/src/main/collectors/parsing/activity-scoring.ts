/**
 * @file activity-scoring.ts
 * @description FEA-2269 (PRD-488): the PURE, deterministic per-window scorers the
 * structural classifier uses to label one window of abstract evidence. Split out
 * of the classifier so the scoring weights are unit-testable in isolation and the
 * classifier's Cognitive Complexity stays under the AGENTS.md limit.
 *
 * The layered model (PRD-488 FR-3): score a window from its abstract
 * `ToolCategory` mix (the STRUCTURAL workhorse), with `declared` intent as a
 * confidence boost + `plan` contributor. NO single layer is required to produce a
 * label. Harness-blind: this module reasons only over abstract categories from
 * FEA-2268 — never a vendor tool name (the adapter boundary owns that).
 *
 * ANTI-OVER-FITTING: the winning phase is `argmax` over weighted category counts,
 * never a hard rule keyed on a specific tool/skill/command. `implement` requires
 * `mutate_code` and `plan` forbids it, so a pure-planning window can never
 * fabricate an `implement` label (AC-002.3) and a near-tie honestly falls to
 * `other` (AC-005).
 *
 * CALIBRATION (Q-003): the weights + `ACTIVITY_CONFIDENCE_FLOOR` below are
 * PROVISIONAL. Q-003 fixes the confidence floor and per-cohort targets from the
 * FEA-2266 labelled corpus; until that corpus exists these are reasoned defaults.
 * They are the intended tuning surface — a recalibration adjusts these constants
 * and bumps `ACTIVITY_CLASSIFIER_VERSION`, re-deriving history via the backfill.
 */
import { EvidenceLayer, ToolCategory } from "../evidence/evidence-model.js";
import {
  ACTIVE_PHASE_ORDER,
  ACTIVITY_PHASE,
  type ActivityPhase,
} from "./activity-taxonomy.js";

/** A window's abstract-category counts (the per-window slice of the mix). */
export type ActivityCategoryCounts = Record<ToolCategory, number>;

/** The scored label for one window: phase + confidence + contributing layers. */
type WindowScore = {
  phase: ActivityPhase;
  /** 0–1; the same fixed scale FEA-2267 persists and FEA-2266 buckets. */
  confidence: number;
  /** The ranked layers that fed the label (`declared` first when present). */
  layers: EvidenceLayer[];
};

// ── Provisional scoring weights (the Q-003 tuning surface) ───────────────────
// mutate_code dominates the implement signal; run_command only SUPPORTS implement
// alongside mutation (a bare command is ops/explore, not implementation).
const WEIGHT_MUTATE = 3;
const WEIGHT_RUN_SUPPORT = 1;
// read/search → explore; test_run → validate; git_lifecycle → review.
const WEIGHT_READ = 2;
const WEIGHT_TEST = 3;
const WEIGHT_GIT = 3;
// Planning is human-steering + declared intent with NO code mutation.
const WEIGHT_HUMAN = 1;
const WEIGHT_DECLARE = 2;

/**
 * The confidence a window must clear to keep its winning label; below it the
 * window is the honest `other` bucket (AC-005). PROVISIONAL — Q-003 fixes the
 * real floor from the FEA-2266 corpus. Confidence is the runner-up MARGIN
 * (`(winner − runnerUp) / winner`), so 0.5 means "the winner beats the runner-up
 * by at least a 2:1 score".
 */
export const ACTIVITY_CONFIDENCE_FLOOR = 0.5;

/** A declared-intent signal in the window lifts confidence — declared is trusted. */
const DECLARED_CONFIDENCE_BOOST = 0.15;

function implementScore(counts: ActivityCategoryCounts): number {
  const mutate = counts[ToolCategory.MutateCode];
  if (mutate === 0) {
    // No fabricated implement without code mutation (AC-002.3 / pure-planning).
    return 0;
  }
  return (
    WEIGHT_MUTATE * mutate +
    WEIGHT_RUN_SUPPORT * counts[ToolCategory.RunCommand]
  );
}

function exploreScore(counts: ActivityCategoryCounts): number {
  return WEIGHT_READ * counts[ToolCategory.ReadSearch];
}

function validateScore(counts: ActivityCategoryCounts): number {
  return WEIGHT_TEST * counts[ToolCategory.TestRun];
}

function reviewScore(counts: ActivityCategoryCounts): number {
  return WEIGHT_GIT * counts[ToolCategory.GitLifecycle];
}

function planScore(counts: ActivityCategoryCounts): number {
  if (counts[ToolCategory.MutateCode] > 0) {
    // A window that mutates code is not planning, however much steering it has.
    return 0;
  }
  return (
    WEIGHT_HUMAN * counts[ToolCategory.HumanTurn] +
    WEIGHT_DECLARE * counts[ToolCategory.DeclaredIntent]
  );
}

// Aligned 1:1 with ACTIVE_PHASE_ORDER — the scorer maps that array onto these.
const PHASE_SCORERS = {
  [ACTIVITY_PHASE.Explore]: exploreScore,
  [ACTIVITY_PHASE.Plan]: planScore,
  [ACTIVITY_PHASE.Implement]: implementScore,
  [ACTIVITY_PHASE.Review]: reviewScore,
  [ACTIVITY_PHASE.Validate]: validateScore,
} as const;

function hasStructuralSignal(counts: ActivityCategoryCounts): boolean {
  return (
    counts[ToolCategory.ReadSearch] > 0 ||
    counts[ToolCategory.MutateCode] > 0 ||
    counts[ToolCategory.RunCommand] > 0 ||
    counts[ToolCategory.TestRun] > 0 ||
    counts[ToolCategory.GitLifecycle] > 0 ||
    counts[ToolCategory.HumanTurn] > 0
  );
}

/** The ranked layers that contributed signal to this window (declared first). */
function contributingLayers(counts: ActivityCategoryCounts): EvidenceLayer[] {
  const layers: EvidenceLayer[] = [];
  if (counts[ToolCategory.DeclaredIntent] > 0) {
    layers.push(EvidenceLayer.Declared);
  }
  if (hasStructuralSignal(counts)) {
    layers.push(EvidenceLayer.Structural);
  }
  return layers;
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

// The winner is the first index of the max score (ACTIVE_PHASE_ORDER is the
// deterministic tie-break); the runner-up is the max of the rest.
function winnerAndRunnerUp(scores: readonly number[]): {
  winnerIdx: number;
  winner: number;
  runnerUp: number;
} {
  let winnerIdx = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[winnerIdx]) {
      winnerIdx = i;
    }
  }
  let runnerUp = 0;
  for (let i = 0; i < scores.length; i++) {
    if (i !== winnerIdx && scores[i] > runnerUp) {
      runnerUp = scores[i];
    }
  }
  return { winnerIdx, winner: scores[winnerIdx], runnerUp };
}

/**
 * Score one window of abstract evidence into a phase + confidence + contributing
 * layers. Pure and deterministic: identical counts → identical result. A window
 * with no active-work signal, or whose winner does not clear
 * `ACTIVITY_CONFIDENCE_FLOOR`, is the honest `other` bucket (never dropped, never
 * force-fit) with its (low) confidence and layers still recorded.
 */
export function scoreWindow(counts: ActivityCategoryCounts): WindowScore {
  const scores = ACTIVE_PHASE_ORDER.map((phase) =>
    PHASE_SCORERS[phase](counts)
  );
  const layers = contributingLayers(counts);
  const { winnerIdx, winner, runnerUp } = winnerAndRunnerUp(scores);
  if (winner === 0) {
    return { phase: ACTIVITY_PHASE.Other, confidence: 0, layers };
  }
  const margin = (winner - runnerUp) / winner;
  const boost =
    counts[ToolCategory.DeclaredIntent] > 0 ? DECLARED_CONFIDENCE_BOOST : 0;
  const confidence = clamp01(margin + boost);
  if (confidence < ACTIVITY_CONFIDENCE_FLOOR) {
    return { phase: ACTIVITY_PHASE.Other, confidence, layers };
  }
  return { phase: ACTIVE_PHASE_ORDER[winnerIdx], confidence, layers };
}
