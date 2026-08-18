/**
 * @file activity-scoring.ts
 * @description FEA-2269 (PRD-488): the PURE, deterministic per-window scorers the
 * structural classifier uses to label one window of abstract evidence. Split out
 * of the classifier so the scoring weights are unit-testable in isolation and the
 * classifier's Cognitive Complexity stays under the AGENTS.md limit.
 *
 * The layered model (PRD-488 FR-3): score a window from its abstract
 * `ToolCategory` mix (the STRUCTURAL workhorse), with a `declared` signal as a
 * confidence boost + `plan` contributor. Most labels need no single required
 * layer; `plan` is the one exception — it requires a PLAN-SPECIFIC declared
 * signal (`DeclaredPlan`, FEA-4184), so neither a bare human turn NOR a generic
 * declaration (an `implement` trace phase) can fabricate it — and since AA-03 an
 * unrecognized name-derived signal (an MCP `get-document`, a `/code-review`) is
 * inert `DeclaredUtility`, contributing no boost and no mass at all.
 * Harness-blind: this module reasons only over abstract
 * categories from FEA-2268 — never a vendor tool name (the adapter boundary owns
 * that; `declaredCategoryFor` owns the plan-vs-inert split).
 *
 * ANTI-OVER-FITTING: the winning phase is `argmax` over weighted category counts,
 * never a hard rule keyed on a specific tool/skill/command. `implement` requires
 * `mutate_code` and forbids `plan`; `plan` requires a plan-specific `declared`
 * signal and forbids `mutate_code`, so a pure-planning window can never fabricate
 * an `implement` label (AC-002.3) and a near-tie honestly falls to `other`
 * (AC-005).
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
// AA-09 (C1): a documentation edit is a real deliverable but weak evidence of
// implementation, so it scores implement at a third of a source edit — enough
// that a docs window still labels, never enough to outvote real code beside it.
const WEIGHT_MUTATE_DOCUMENT = 1;
const WEIGHT_RUN_SUPPORT = 1;
// read/search → explore; test_run → validate. git_lifecycle is AMBIENT under the
// state-aware model (PRD-488): a commit/push/PR scores no phase of its own and
// inherits the current phase in the stateful carry pass — so there is no git
// weight here, and `review` is a DECLARED-only label (a review REQUEST), not a
// git-lifecycle argmax.
const WEIGHT_READ = 2;
const WEIGHT_TEST = 3;
// Planning requires a DECLARED planning signal with NO code mutation (FEA-4184);
// human-steering only BOOSTS a genuinely-declared plan window (see `planScore`).
const WEIGHT_HUMAN = 1;
const WEIGHT_DECLARE = 2;

/**
 * The runner-up MARGIN a window must clear for its winning phase to survive as
 * the LABEL; below it the window is the honest `other` bucket (AC-005).
 * PROVISIONAL — Q-003 fixes the real floor from the FEA-2266 corpus. The LABEL
 * gate keys on this margin (`(winner − runnerUp) / winner`), so 0.5 means "the
 * winner beats the runner-up by at least a 2:1 score". NOTE (AA-11): the margin
 * gates the label, but the STORED confidence is the margin tempered by evidence
 * mass + layer corroboration (see {@link temperedConfidence}) — the two are
 * deliberately distinct so a single thin signal cannot report as maximal
 * confidence. AA-02 revisits whether the label gate itself should move onto the
 * tempered confidence; until then the gate is margin-only (no label churn here).
 */
export const ACTIVITY_CONFIDENCE_FLOOR = 0.5;

/** A declared-intent signal in the window lifts confidence — declared is trusted. */
const DECLARED_CONFIDENCE_BOOST = 0.15;

// ── AA-11 confidence tempering (the Q-003 tuning surface) ────────────────────
// Raw margin `(winner − runnerUp) / winner` peaks at 1.0 whenever a SINGLE
// scorer fires (runner-up 0) — i.e. on the THINNEST windows — so a lone read or
// a single machine prompt read as maximally confident (audit AA-11). The stored
// confidence is instead the margin scaled by how much corroborating evidence the
// window actually carries, with a hard cap on single-LAYER windows so only
// declared+structural corroboration can approach 1.0.
//
// Evidence-mass half-saturation (units): `mass/(mass+MASS_SATURATION)` is 0.5 at
// this many contributing units and saturates toward 1 as mass grows.
const MASS_SATURATION = 3;
// The mass factor never drops the margin below this fraction of itself — a
// genuinely dominant single-tick window still reads as moderately confident,
// just never maximal.
const MASS_FLOOR_SCALE = 0.6;
// A window whose evidence is a SINGLE ranked layer (structural-only OR
// declared-only) can never exceed this. Multi-layer corroboration
// (`declared`+`structural`) is what earns confidence near 1.0.
const SINGLE_LAYER_CONFIDENCE_CAP = 0.7;

function implementScore(counts: ActivityCategoryCounts): number {
  const mutate = counts[ToolCategory.MutateCode];
  // AA-09 (C1): documentation is a workspace DELIVERABLE, so it scores implement
  // — but at a fraction of a source edit, because prose is much weaker evidence
  // that the system under construction actually changed. Keeping it out entirely
  // would have made a documentation-writing window score nothing at all and fall
  // to `other`, trading one wrong answer for a blank one. `MutateScratch` is
  // absent by design: agent bookkeeping is not a deliverable at any weight.
  const document = counts[ToolCategory.MutateDocument];
  if (mutate === 0 && document === 0) {
    // No fabricated implement without a mutation (AC-002.3 / pure-planning).
    return 0;
  }
  // AA-09 (C2): an un-refined `RunCommand` is a command whose effect the core
  // could NOT determine (AA-04 already reclassified the confidently read-only
  // ones as `ReadSearch`). Such commands may only SUPPORT implement in proportion
  // to the mutation they accompany — never outvote it. Before this cap, one edit
  // beside twenty unreadable commands scored implement 23, so a session that
  // merely ran analysis scripts near a scratch write read as heavy implementation
  // (the audit's E-1 failure). Bounding support by `mutate` keeps corroboration
  // meaningful while making the mutation evidence the thing that actually decides.
  // Support is bounded by the SOURCE mutation only: an unreadable command beside
  // a documentation edit corroborates nothing about implementation.
  const support = Math.min(counts[ToolCategory.RunCommand], mutate);
  return (
    WEIGHT_MUTATE * mutate +
    WEIGHT_MUTATE_DOCUMENT * document +
    WEIGHT_RUN_SUPPORT * support
  );
}

function exploreScore(counts: ActivityCategoryCounts): number {
  return WEIGHT_READ * counts[ToolCategory.ReadSearch];
}

function validateScore(counts: ActivityCategoryCounts): number {
  return WEIGHT_TEST * counts[ToolCategory.TestRun];
}

function planScore(counts: ActivityCategoryCounts): number {
  if (counts[ToolCategory.MutateCode] > 0) {
    // A window that mutates SOURCE is not planning, however much steering it has.
    // AA-09 (C1) narrowed this veto to the code kind on purpose: writing the plan
    // document IS planning, and a `MEMORY.md` handoff is bookkeeping — neither
    // should be able to veto a window the user explicitly declared as planning.
    return 0;
  }
  // `plan` requires a PLAN-SPECIFIC declared signal (a plan skill/slash-command
  // like `/create-plan`, an `ExitPlanMode`-style MCP call, or a trace phase
  // declaring "plan") — NOT merely any declared intent. The evidence core splits
  // declarations into `DeclaredPlan` (plan-specific), the generic `DeclaredIntent`
  // (since AA-03, a non-plan TRACE PHASE only — e.g. one labelled `implement`), and
  // the inert `DeclaredUtility` (every unrecognized skill / MCP / slash-command
  // name); see `declaredCategoryFor` in `evidence-model.ts`. Gating on the GENERIC
  // declared count would let any declaration (an MCP `get-document`, a
  // `/code-review`) fabricate `plan` in a
  // no-mutation window — the false positive codex flagged (FEA-4184). A bare human
  // turn is likewise AMBIENT steering ("fix the login bug" is not planning), so
  // human turns alone must NOT win the `plan` argmax either. With no plan-specific
  // declaration there is no plan; human turns only BOOST a genuinely-declared plan
  // window. Left ungated, a lone `plan` tick scored full confidence and the
  // state-aware carry (`phase-carry.ts`) propagated it across the session,
  // mislabelling explore/implement stretches (and the branch rollup) as `plan`.
  if (counts[ToolCategory.DeclaredPlan] === 0) {
    return 0;
  }
  return (
    WEIGHT_HUMAN * counts[ToolCategory.HumanTurn] +
    WEIGHT_DECLARE * counts[ToolCategory.DeclaredPlan]
  );
}

// Aligned 1:1 with ACTIVE_PHASE_ORDER — the scorer maps that array onto these.
const PHASE_SCORERS = {
  [ACTIVITY_PHASE.Explore]: exploreScore,
  [ACTIVITY_PHASE.Plan]: planScore,
  [ACTIVITY_PHASE.Implement]: implementScore,
  [ACTIVITY_PHASE.Validate]: validateScore,
} as const;

/**
 * True when the window carries structural signal that CORROBORATES a phase.
 *
 * `RunCommand` is excluded for exactly the reason it is excluded from
 * {@link evidenceMass} (AA-09 C2): an un-refined shell command is residue nobody
 * could read, so it must not unlock the two-layer confidence a genuinely
 * corroborated window earns. Counting it here let a `{DeclaredPlan: 1}` window —
 * correctly capped at {@link SINGLE_LAYER_CONFIDENCE_CAP} as single-layer — reach
 * 0.85 purely by adding one unreadable command, which is the same inflation C2
 * removed from the mass term.
 */
function hasStructuralSignal(counts: ActivityCategoryCounts): boolean {
  return (
    counts[ToolCategory.ReadSearch] > 0 ||
    counts[ToolCategory.MutateCode] > 0 ||
    counts[ToolCategory.MutateDocument] > 0 ||
    counts[ToolCategory.TestRun] > 0 ||
    counts[ToolCategory.GitLifecycle] > 0 ||
    counts[ToolCategory.HumanTurn] > 0
  );
}

/** True when the window carries any declared signal — generic OR plan-specific
 * (FEA-4184). Both feed the declared layer + confidence boost; only the
 * plan-specific one gates `plan` (see `planScore`). */
function hasDeclaredSignal(counts: ActivityCategoryCounts): boolean {
  return (
    counts[ToolCategory.DeclaredIntent] > 0 ||
    counts[ToolCategory.DeclaredPlan] > 0
  );
}

/** The ranked layers that contributed signal to this window (declared first). */
function contributingLayers(counts: ActivityCategoryCounts): EvidenceLayer[] {
  const layers: EvidenceLayer[] = [];
  if (hasDeclaredSignal(counts)) {
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
 * Categories that anchor TIME but corroborate no phase, so they must not raise
 * AA-11's tempered confidence:
 *   - `DeclaredUtility` (AA-03): an auth / model-switch / unrecognized declaration.
 *   - `RunCommand` (AA-09 C2): an UN-REFINED command — one whose effect the core
 *     could not determine. AA-04 already promotes the confidently read-only ones
 *     to `ReadSearch`, and test/git lifecycle refine out too, so what remains here
 *     is precisely the unreadable residue. It may still SUPPORT implement (bounded
 *     by the mutation it accompanies, see {@link implementScore}), but letting it
 *     also add mass meant twenty unreadable commands reported a MORE confident
 *     implement claim than two — confidence rising on evidence nobody could read.
 *   - `MutateScratch` (AA-09 C1): a write to the harness's OWN bookkeeping or to a
 *     bare system-temp transient. It is genuine observed activity and still anchors
 *     time, but nothing in the project changed, so it must not raise the confidence
 *     of whatever label the window lands on. One corpus session performs 19 memory-
 *     file writes against 17 real source edits; counting those as corroboration
 *     would report its most confident implement claims over its bookkeeping.
 */
const NON_CORROBORATING_CATEGORIES: ReadonlySet<ToolCategory> = new Set([
  ToolCategory.DeclaredUtility,
  ToolCategory.RunCommand,
  ToolCategory.MutateScratch,
]);

/**
 * Total CONTRIBUTING evidence units in the window — everything except the
 * {@link NON_CORROBORATING_CATEGORIES}.
 */
function evidenceMass(counts: ActivityCategoryCounts): number {
  let mass = 0;
  for (const category of Object.values(ToolCategory)) {
    if (NON_CORROBORATING_CATEGORIES.has(category)) {
      continue;
    }
    mass += counts[category];
  }
  return mass;
}

/**
 * AA-11: the STORED confidence — the runner-up margin tempered so a thin window
 * cannot read as maximally confident. Two independent discounts:
 *   1. Evidence mass: scale by `mass/(mass+MASS_SATURATION)` (floored at
 *      `MASS_FLOOR_SCALE`) so one unit weighs less than many.
 *   2. Layer corroboration: a single-layer window (structural-only OR
 *      declared-only, `layerCount ≤ 1`) is hard-capped at
 *      `SINGLE_LAYER_CONFIDENCE_CAP`; only `declared`+`structural` agreement can
 *      approach 1.0, lifted the last step by the declared boost.
 * Pure: identical counts → identical result.
 */
function temperedConfidence(
  counts: ActivityCategoryCounts,
  margin: number,
  boost: number,
  layerCount: number
): number {
  const mass = evidenceMass(counts);
  const massScale = mass / (mass + MASS_SATURATION);
  const massFactor = MASS_FLOOR_SCALE + (1 - MASS_FLOOR_SCALE) * massScale;
  let confidence = margin * massFactor + boost;
  if (layerCount <= 1) {
    confidence = Math.min(confidence, SINGLE_LAYER_CONFIDENCE_CAP);
  }
  return clamp01(confidence);
}

/**
 * Score one window of abstract evidence into a phase + confidence + contributing
 * layers. Pure and deterministic: identical counts → identical result. A window
 * with no active-work signal, or whose winner does not clear
 * `ACTIVITY_CONFIDENCE_FLOOR`, is the honest `other` bucket (never dropped, never
 * force-fit) with its (low) confidence and layers still recorded.
 *
 * The winning PHASE is gated on the raw runner-up margin (unchanged), so this
 * function's tiling decisions are identical to before AA-11; only the STORED
 * `confidence` is tempered ({@link temperedConfidence}) so a single thin signal
 * no longer reports as maximal certainty.
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
  // FEA-4184: the boost keys on ANY declared signal (`DeclaredPlan` or the generic
  // `DeclaredIntent`), so a plan-specific declaration still boosts.
  const boost = hasDeclaredSignal(counts) ? DECLARED_CONFIDENCE_BOOST : 0;
  const confidence = temperedConfidence(counts, margin, boost, layers.length);
  // The LABEL gate keys on the raw margin (AA-02 revisits this coupling), so the
  // phase tiling is identical to FEA-4184's; the tempered value is what we persist.
  if (clamp01(margin + boost) < ACTIVITY_CONFIDENCE_FLOOR) {
    return { phase: ACTIVITY_PHASE.Other, confidence, layers };
  }
  return { phase: ACTIVE_PHASE_ORDER[winnerIdx], confidence, layers };
}
