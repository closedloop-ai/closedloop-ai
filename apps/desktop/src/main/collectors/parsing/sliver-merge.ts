/**
 * @file sliver-merge.ts
 * @description FEA-4010 (AA-12): the PURE tiling-hygiene post-pass that merges
 * sub-threshold span-edge "slivers" into an adjacent active segment. A sliver is
 * the leading `[activeStart, firstTick)` / trailing `[lastTick+1, activeBreak)`
 * artifact a relabel split can isolate, whose scored label is anchored on evidence
 * lying OUTSIDE its own bounds — tiling noise that distorts segment counts and
 * first/last-phase queries.
 *
 * Extracted as its own sibling post-pass (mirroring `rework-detector.ts`,
 * `phase-carry.ts`, `subagent-purpose.ts`) and kept GENERIC over the shared
 * `RelabelableSegment` contract so it never imports the classifier that consumes
 * it (no cycle). Like the sibling passes it only widens/relabels existing
 * intervals, so complete tiling and Σ(segment spend) == session-total hold.
 */
import {
  coalesceAdjacentRuns,
  type RelabelableSegment,
  sameRunByProvenance,
} from "./activity-segment-relabel.js";
import {
  ACTIVE_PHASE_ORDER,
  ACTIVITY_PHASE,
  type ActivityPhase,
} from "./activity-taxonomy.js";

/**
 * AA-12: an ACTIVE segment shorter than this is a span-edge sliver — below this
 * width the segment is tiling noise and is merged into an adjacent active segment
 * before persist. Provisional (Q-003 tuning surface), versioned by
 * ACTIVITY_CLASSIFIER_VERSION. `idle` segments are never slivers (they exist only
 * at ≥ ACTIVITY_IDLE_GAP_MS), so this only ever merges active noise, never dead
 * time.
 */
export const ACTIVITY_SLIVER_MS = 2000;

/** The minimal shape this pass reads: a relabelable segment plus the optional
 * delegated-spend / work-item provenance axes it must not silently drop. */
type MergeableSegment = RelabelableSegment & {
  subagentId?: string | null;
  workItemRef?: string | null;
};

/**
 * The phases whose slivers are safe to absorb: only the STRUCTURAL scorer's own
 * labels (`ACTIVE_PHASE_ORDER` + the `other` sub-floor). The DECLARED/detected
 * post-pass labels (`review`, `rework`) carry meaning a merge would erase, so they
 * are deliberately EXCLUDED — a sub-2s declared review window must survive, not be
 * silently folded into a neighbor. Framing this as an allow-set over the structural
 * phases means a newly-added declared phase defaults to PRESERVED (the safe
 * direction), mirroring `phase-carry.ts`'s `AMBIENT_PHASES` framing.
 */
const MERGEABLE_SLIVER_PHASES: ReadonlySet<ActivityPhase> = new Set([
  ...ACTIVE_PHASE_ORDER,
  ACTIVITY_PHASE.Other,
]);

/** The structural scorer's own active labels, WITHOUT the `other` sub-floor — the
 * phases a carried (inherited) window can hold (see {@link isCarriedWindow}). */
const ACTIVE_PHASE_SET: ReadonlySet<ActivityPhase> = new Set(
  ACTIVE_PHASE_ORDER
);

/** True when a segment is active (not the first-class `idle` kind). */
function isActive(seg: Pick<RelabelableSegment, "phase">): boolean {
  return seg.phase !== ACTIVITY_PHASE.Idle;
}

/** True when a segment belongs to a subagent (delegated spend), not the main agent. */
function isOwned(seg: MergeableSegment): boolean {
  return (seg.subagentId ?? null) !== null;
}

/**
 * True when a segment is a CARRIED (inherited-phase) window from the phase-carry
 * post-pass (AA-05), identified structurally: an active-scorer phase
 * (`ACTIVE_PHASE_SET`) with ZERO evidence layers. This is unambiguous — a window
 * the structural scorer labels with an active phase always contributes ≥1 evidence
 * layer (declared and/or structural), so an empty-evidence active-phase segment can
 * ONLY be one phase-carry stamped by inheritance. Such a window was deliberately
 * marked evidence-free at a capped confidence; absorbing it would let a neighbor's
 * first-hand evidence + higher confidence widen over a span AA-05 declared it does
 * not have, silently re-inflating the evidence-backed footprint. (Carried `review`/
 * `rework` windows are already excluded via {@link MERGEABLE_SLIVER_PHASES}; this
 * covers the carried `plan`/`implement`/`validate` case.)
 */
function isCarriedWindow(seg: MergeableSegment): boolean {
  return seg.evidenceLayers.length === 0 && ACTIVE_PHASE_SET.has(seg.phase);
}

/**
 * Whether `sliver` may be absorbed into `neighbor`. All guards required; on any
 * miss the sliver is KEPT as its own segment (honest, if brief) rather than losing
 * its label, ownership, or evidence provenance:
 *   - the sliver's phase is structural noise (not a declared `review`/`rework`);
 *   - the sliver is NOT subagent-owned — AA-12 keeps delegated slices whole, so an
 *     owned sliver survives even next to the SAME subagent's differently-phased span
 *     (a same-phase owned pair still re-coalesces via the trailing pass);
 *   - the sliver is NOT a carried window — AA-05's capped-confidence / empty-evidence
 *     inheritance must not be overwritten by a neighbor widening over it;
 *   - the neighbor is also main-agent, and their `workItemRef` matches — so
 *     main-agent spend is never re-attributed across owners or work items.
 * Mirrors the run identity the trailing {@link sameRunByProvenance} coalesce
 * enforces, applied to the merge itself.
 */
function canAbsorbSliver(
  sliver: MergeableSegment,
  neighbor: MergeableSegment
): boolean {
  return (
    MERGEABLE_SLIVER_PHASES.has(sliver.phase) &&
    !isOwned(sliver) &&
    !isCarriedWindow(sliver) &&
    !isOwned(neighbor) &&
    (sliver.workItemRef ?? null) === (neighbor.workItemRef ?? null)
  );
}

function isSliver(seg: MergeableSegment): boolean {
  return isActive(seg) && seg.endMs - seg.startMs < ACTIVITY_SLIVER_MS;
}

/**
 * AA-12: merge sub-threshold span-edge slivers ({@link ACTIVITY_SLIVER_MS}) into
 * an adjacent ACTIVE segment, then coalesce any same-run pieces the removal left
 * adjacent. A sliver merges into its previous active segment when one exists AND
 * that neighbor can absorb it ({@link canAbsorbSliver}) — the common tail case —
 * else grafts its span onto the next active segment (forward — the head/pre-kickoff
 * case). A sliver whose only neighbors are `idle` / the session edge, or that
 * {@link canAbsorbSliver} rejects — a declared `review`/`rework` window, a
 * subagent-owned slice, a carried (inherited-phase) window, or one adjacent only to
 * differently-owned / different-work-item work — is KEPT as-is: merging it would
 * erase a declared phase, misattribute delegated spend, or overwrite AA-05's
 * capped-confidence / empty-evidence carry.
 * Pure tiling hygiene: the surviving neighbor's record simply widens to cover the
 * sliver's `[start, end)`, so complete tiling and Σ-reconciliation are preserved;
 * only a <2s slice of spend re-attributes to the neighbor's phase.
 */
export function mergeSlivers<T extends MergeableSegment>(
  segments: readonly T[]
): T[] {
  const merged: T[] = [];
  // A preceding forward-merged sliver's start to graft onto the next segment.
  let pendingStart: number | null = null;
  for (let i = 0; i < segments.length; i++) {
    let seg = segments[i];
    if (pendingStart !== null) {
      seg = { ...seg, startMs: pendingStart };
      pendingStart = null;
    }
    if (!isSliver(seg)) {
      merged.push(seg);
      continue;
    }
    const prev = merged.at(-1);
    const next = segments[i + 1];
    if (prev && isActive(prev) && canAbsorbSliver(seg, prev)) {
      merged[merged.length - 1] = { ...prev, endMs: seg.endMs };
    } else if (next && isActive(next) && canAbsorbSliver(seg, next)) {
      pendingStart = seg.startMs;
    } else {
      merged.push(seg);
    }
  }
  return coalesceAdjacentRuns(merged, sameRunByProvenance);
}
