/**
 * @file phase-carry.ts
 * @description PRD-488 "State-Aware Session Activity Attribution": the stateful
 * carry post-pass. The FEA-2269 structural scorer labels each window in isolation
 * (reads → `explore`, edits → `implement`, tests → `validate`), which is
 * STATELESS — a read anywhere becomes `explore`, even deep inside an implement
 * burst. This pass makes the tiling STATE-AWARE:
 *
 *   - `explore` is only the LEADING orientation — the work before any strong
 *     phase begins. Once a strong phase has started, `explore` never recurs.
 *   - A strong phase (plan / implement / validate / a prior `rework` relabel, or
 *     a DECLARED review REQUEST) sets the "current phase".
 *   - AMBIENT activity (a read window scored `explore`, or an evidence-free /
 *     git-only window scored `other`) INHERITS the current phase instead of
 *     re-bucketing to `explore` — "attribute it to the current state".
 *   - A review REQUEST ({@link ../review-intent-detector}) transitions the current
 *     phase to `review` (the declared-only label), splitting the containing
 *     segment at the exact request instant so `review` starts precisely there.
 *
 * Pure + deterministic (reads only its inputs — no wall clock, no randomness).
 * Like the sibling relabel passes it only SUBDIVIDES existing intervals and
 * relabels them, never moving an FEA-2269 boundary or inventing time, so
 * complete-tiling and Σ(segment spend) == session-total are preserved.
 */
import { EvidenceLayer } from "../evidence/evidence-model.js";
import {
  coalesceAdjacentRuns,
  type RelabelableSegment,
  sameRunByLabel,
  splitAtCuts,
} from "./activity-segment-relabel.js";
import { ACTIVITY_PHASE, type ActivityPhase } from "./activity-taxonomy.js";

/**
 * Confidence a declared review-REQUEST segment carries (0–1). The user explicitly
 * asked for a review, so it is high like the address-review rework prompt. Named
 * + versioned by `ACTIVITY_CLASSIFIER_VERSION` (the Q-003 tuning surface).
 */
export const REVIEW_REQUEST_CONFIDENCE = 0.9;

/**
 * AA-05: the confidence ceiling for a carried (inherited-phase) window. An
 * inherited label is inferential, not observed, so it is capped well below the
 * establishing window's confidence — never at the maximal 1.0 that evidence-free
 * carry stamped before. The stored value is `min(establishing, this)` so a
 * carried window is never MORE confident than the window that set the phase.
 * Named + versioned by `ACTIVITY_CLASSIFIER_VERSION` (the Q-003 tuning surface).
 */
export const CARRIED_CONFIDENCE = 0.5;

/**
 * The AMBIENT phases — the closed, stable set that INHERITS the current phase
 * rather than establishing one: `explore` (the leading orientation / a read window)
 * and `other` (the sub-floor / git-only / evidence-free window). Every OTHER active
 * phase — `plan`, `implement`, `validate`, `rework` (already a strong, phase-setting
 * label by the time we walk, since the rework post-pass runs first), and ANY future
 * phase added to `ACTIVE_PHASE_ORDER` — is STRONG and sets the current phase.
 *
 * Framing the check around this two-member ambient set (rather than hand-listing the
 * strong phases, which would silently treat a newly-added active phase as ambient)
 * makes a new active phase default to STRONG — carried, not silently absorbed — the
 * safe direction. `idle` is handled first and never reaches this check; `review` is
 * produced by the review-request branch, not the structural scorer, so it never
 * appears pre-carry.
 */
const AMBIENT_PHASES: ReadonlySet<ActivityPhase> = new Set([
  ACTIVITY_PHASE.Explore,
  ACTIVITY_PHASE.Other,
]);

/**
 * The current-phase state a following ambient window inherits. AA-05: only the
 * `phase` is inherited; the carried window gets a CAPPED confidence
 * (`min(confidence, CARRIED_CONFIDENCE)`) and EMPTY evidence layers rather than
 * the establishing window's confidence + layers verbatim — so the establishing
 * confidence is kept here purely to bound the cap.
 */
type PhaseState = {
  phase: ActivityPhase;
  confidence: number;
};

/** True when a review was requested at an instant this (post-split) piece covers,
 * i.e. the piece begins the review. */
function coversReviewRequest(
  seg: RelabelableSegment,
  reviewRequestMs: readonly number[]
): boolean {
  return reviewRequestMs.some((t) => t >= seg.startMs && t < seg.endMs);
}

/**
 * Split each ACTIVE segment at any review-request instant strictly interior to
 * it, so `review` can begin at the exact request rather than the segment start.
 * `idle` is never split: a request that fell inside an idle gap has already been
 * snapped forward to the following active segment's start by
 * {@link snapReviewRequestsOutOfIdle}, so no interior idle cut is ever needed
 * (and splitting `idle` would introduce a spurious spend-free boundary).
 */
function splitAtReviewRequests<T extends RelabelableSegment>(
  segments: readonly T[],
  reviewRequestMs: readonly number[]
): T[] {
  const out: T[] = [];
  for (const seg of segments) {
    if (seg.phase === ACTIVITY_PHASE.Idle) {
      out.push(seg);
      continue;
    }
    const cuts = reviewRequestMs.filter(
      (t) => t > seg.startMs && t < seg.endMs
    );
    for (const piece of splitAtCuts(seg, cuts)) {
      out.push(piece);
    }
  }
  return out;
}

/**
 * Snap any review-request instant that lands STRICTLY inside an `idle` segment
 * forward to that idle segment's end (== the next active segment's start). Idle
 * boundaries are derived from TURN (assistant) timestamps, but a review request is
 * a HUMAN message / slash command whose instant is not a turn — so a `/code-review`
 * (or "review my changes") issued after an idle break (≥ ACTIVITY_IDLE_GAP_MS)
 * falls inside the spend-free gap. Left un-snapped it would match no segment (`idle`
 * is never split, and the following active segment starts AFTER the instant, so
 * {@link coversReviewRequest} is false there too) and be silently dropped — losing
 * the `review` phase, the very failure this pass exists to prevent. Snapping forward
 * makes the first active piece after the break BEGIN the review. When the idle is
 * an INTERIOR gap (the common case) an active segment follows to receive the snap.
 * AA-01 lets `idle` also be the HEAD or TAIL segment: a request inside a head idle
 * snaps to the first active segment's start (still received); a request inside a
 * trailing idle snaps to `endMs`, which matches no segment and is dropped — the
 * safe outcome, since no active work followed the request to carry the `review`.
 */
function snapReviewRequestsOutOfIdle(
  segments: readonly RelabelableSegment[],
  reviewRequestMs: readonly number[]
): number[] {
  const idleSpans = segments.filter((s) => s.phase === ACTIVITY_PHASE.Idle);
  const snapped = reviewRequestMs.map((t) => {
    const idle = idleSpans.find((s) => t >= s.startMs && t < s.endMs);
    return idle ? idle.endMs : t;
  });
  return [...new Set(snapped)].sort((a, b) => a - b);
}

/**
 * Re-attribute the structural tiling to a state-aware phase progression (see the
 * file docstring). `reviewRequestMs` are the sorted review-request instants from
 * {@link ../review-intent-detector}. Runs AFTER the rework post-pass so a `rework`
 * relabel is already a strong phase, and BEFORE the subagent post-pass so
 * delegated spend is re-filed by the subagent's own purpose last.
 */
export function applyStatefulPhaseCarry<T extends RelabelableSegment>(
  segments: readonly T[],
  reviewRequestMs: readonly number[]
): T[] {
  // A request inside an idle gap is snapped to the following active segment first,
  // so it is never lost between turns (see snapReviewRequestsOutOfIdle).
  const effectiveReviewRequestMs = snapReviewRequestsOutOfIdle(
    segments,
    reviewRequestMs
  );
  const pieces = splitAtReviewRequests(segments, effectiveReviewRequestMs);
  const result: T[] = [];
  // null = still LEADING (no strong phase yet) — ambient stays as scored.
  let current: PhaseState | null = null;
  for (const seg of pieces) {
    if (seg.phase === ACTIVITY_PHASE.Idle) {
      // AA-05: an idle gap RESETS the carried phase. Every `idle` segment spans
      // ≥ ACTIVITY_IDLE_GAP_MS by construction (the tiler only opens idle for
      // gaps past the threshold), so reaching one means the work paused long
      // enough that resumed activity must RE-ESTABLISH from its own evidence
      // (floor `other`) rather than inherit a now-stale phase across the gap.
      current = null;
      result.push(seg);
      continue;
    }
    if (coversReviewRequest(seg, effectiveReviewRequestMs)) {
      // Review-establishing window: the request itself is first-hand declared
      // evidence, so it keeps real confidence + layers (not a carried marker).
      result.push({
        ...seg,
        phase: ACTIVITY_PHASE.Review,
        confidence: REVIEW_REQUEST_CONFIDENCE,
        evidenceLayers: [EvidenceLayer.Declared, EvidenceLayer.Structural],
      });
      current = {
        phase: ACTIVITY_PHASE.Review,
        confidence: REVIEW_REQUEST_CONFIDENCE,
      };
      continue;
    }
    if (!AMBIENT_PHASES.has(seg.phase)) {
      // Strong phase (plan / implement / validate / rework, or any future active
      // phase): it ESTABLISHES the current phase and keeps its own scored fields.
      current = { phase: seg.phase, confidence: seg.confidence };
      result.push(seg);
      continue;
    }
    // Ambient window (explore / other): inherit the current phase, or — if still
    // leading — keep the scored label (this is the honest leading `explore`).
    if (current === null) {
      result.push(seg);
    } else {
      // AA-05: inherit the PHASE, but cap the confidence and DROP the evidence
      // layers to empty — an inherited label is inferential, never first-hand,
      // so it must not copy the establishing window's (often maximal) confidence
      // or its `declared`/`structural` provenance, and it must not claim evidence
      // it does not have (empty layers ⇒ downstream `hasEvidence` is false).
      result.push({
        ...seg,
        phase: current.phase,
        confidence: Math.min(current.confidence, CARRIED_CONFIDENCE),
        evidenceLayers: [],
      });
    }
  }
  return coalesceAdjacentRuns(result, sameRunByLabel);
}
