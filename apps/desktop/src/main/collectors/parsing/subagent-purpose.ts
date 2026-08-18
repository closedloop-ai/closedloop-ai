/**
 * @file subagent-purpose.ts
 * @description FEA-2271 (PRD-488, Phase 2): the deterministic, PURE subagent
 * purpose-attribution post-pass. Delegated sub-tasks (subagents) fold their spend
 * into the parent session's token series, so the FEA-2269 tiling attributes it to
 * whatever MAIN-agent phase owned its timestamps — a delegated reviewer's tokens
 * counted as `implement` because the parent was implementing when it dispatched the
 * Task. This post-pass RE-FILES each subagent's own folded spend to a phase derived
 * from the SUBAGENT'S OWN purpose:
 *   1. classify each subagent from its own `toolUses` through the SAME FEA-2268
 *      adapter + FEA-2269 scorer (`categoryMixForToolUses` → `scoreWindow`) to one
 *      whole-subagent purpose phase (single-label; internal per-subagent
 *      micro-tiling is an explicit v1 non-goal), then
 *   2. carve the time windows the subagent's own `tokenSeries` turns occupy out of
 *      the main-agent segments they currently sit in and relabel them to that
 *      purpose, splitting the tiling only at those exact turn boundaries (shared
 *      `activity-segment-relabel` machinery, same as FEA-2270).
 *
 * ── Reconciliation: re-PARTITION, never re-ADD (the load-bearing invariant) ──────
 * The subagent's spend is ALREADY in the parent `token_events` (the parser folded
 * `NormalizedSubagent.tokenSeries` into `session.tokenSeries` exactly once). This
 * pass NEVER sums the subagent's own `tokenSeries` copy into the total — it reads
 * only its TIMESTAMPS to place segment boundaries, then relabels the segment that
 * already owns each row. So `Σ(segment spend)` and `count(token_events)` are
 * byte-identical before and after; only which segment's `phase` owns a row changes,
 * and the FEA-2267 reconciliation invariant still holds.
 *
 * ── Concurrency (Q-007 — PLN-1196 §9 RESOLUTION) ─────────────────────────────────
 * Attribution is by per-turn token spend, NOT wall-clock interval: each subagent's
 * OWN turn timestamps are attributed to its OWN purpose regardless of overlap, so
 * parallel subagents whose active windows overlap never cross-attribute (a span is
 * broken wherever a different owner's turn falls between two of a subagent's turns).
 * The partition is over turn RECORDS; two subagents sharing an identical timestamp
 * (collision) are broken deterministically by subagent id (smallest wins), so
 * re-runs are byte-identical.
 *
 * ── Ordering vs FEA-2270 ─────────────────────────────────────────────────────────
 * Runs AFTER the rework post-pass: a subagent dispatched inside a rework span is
 * re-filed to its OWN purpose (the point of the feature — the subagent's spend is
 * attributed by what the subagent did), overriding the surrounding `rework`; the
 * main agent's own rework turns stay `rework`. `idle` segments are never split or
 * relabelled (spend-free gaps the store owns).
 *
 * Determinism: reads only `NormalizedSession` (+ the tiling) and the version
 * constant — no `Date.now()`, no randomness; every sort/tie-break is explicit.
 */
import { categoryMixForToolUses } from "../evidence/build-session-evidence.js";
import { EvidenceLayer } from "../evidence/evidence-model.js";
import type {
  Harness,
  NormalizedSession,
  NormalizedSubagent,
} from "../types.js";
import { scoreWindow } from "./activity-scoring.js";
import {
  coalesceAdjacentRuns,
  containingSpan,
  interiorCuts,
  type RelabelableSegment,
  sameRunByProvenance,
  sortedUniqueMs,
  splitAtCuts,
} from "./activity-segment-relabel.js";
import { ACTIVITY_PHASE, type ActivityPhase } from "./activity-taxonomy.js";
import { CARRIED_CONFIDENCE } from "./phase-carry.js";

/**
 * AA-08: the DECLARED parent phases a subagent inherits as a prior.
 *
 * A subagent's purpose is scored from its own tool mix, and that mix is
 * read-dominated for exactly the delegations whose purpose is least ambiguous.
 * Measured over the corpus, ALL 74 subagents score `explore` (65) or `other` (9)
 * — not one scores `review`, including two 18-agent review fleets. Reading code
 * IS what reviewing looks like, so its own evidence can never distinguish the
 * two; only the context it was spawned into can.
 *
 * Restricted to phases the parent DECLARED (a review the user requested, a rework
 * the user asked for). An inferred parent phase is itself a guess, and layering a
 * guess on a guess is how confident nonsense gets produced.
 */
const DECLARED_PRIOR_PHASES: ReadonlySet<ActivityPhase> = new Set([
  ACTIVITY_PHASE.Review,
  ACTIVITY_PHASE.Rework,
]);

/**
 * The parent's declaration in force when a subagent was dispatched: the phase it
 * declared, and the confidence that declaration itself carried.
 */
type DeclaredPrior = {
  phase: ActivityPhase;
  confidence: number;
};

/** One subagent's classified whole-subagent purpose. */
type SubagentPurpose = {
  phase: ActivityPhase;
  confidence: number;
  layers: EvidenceLayer[];
};

/**
 * A `[startMs, endMs)` window of ONE subagent's own consecutive turns, to be
 * relabelled to its purpose phase. `subagentId` is the parser-stable local id
 * persisted as the segment's provenance marker (FEA-2275 surfaces delegated spend).
 */
type SubagentSpan = {
  startMs: number;
  endMs: number;
  subagentId: string;
  phase: ActivityPhase;
  confidence: number;
  layers: EvidenceLayer[];
};

/** The owner claim for one turn timestamp: which subagent it belongs to + purpose. */
type TurnClaim = { subagentId: string; purpose: SubagentPurpose };

/** A relabelable segment that can carry the FEA-2271 subagent provenance marker. */
type SubagentRelabelable = RelabelableSegment & { subagentId?: string | null };

/**
 * Classify one subagent to a single whole-subagent purpose from its own tool uses,
 * through the SAME FEA-2268 adapter + FEA-2269 scorer the main agent uses. Returns
 * `other`/0 for an empty or unrecognized tool stream (never force-fit).
 */
export function classifySubagentPurpose(
  subagent: NormalizedSubagent,
  harness: Harness,
  declaredPrior: DeclaredPrior | null = null
): SubagentPurpose {
  const mix = categoryMixForToolUses(subagent.toolUses ?? [], harness);
  const { phase, confidence, layers } = scoreWindow(mix);
  if (declaredPrior === null || contradictsPrior(phase, declaredPrior.phase)) {
    return { phase, confidence, layers };
  }
  // Both the label AND its strength come from the DECLARATION, capped like any
  // inherited attribution (AA-05: `min(establishing.confidence, CARRIED)`).
  // Deriving the number from the subagent's own score ran it backwards — that
  // score belongs to the phase just discarded, so a reader scoring `explore` at
  // 0.7 reported review at 0.5 and one with no readable stream reported review at
  // 0.0, both having inherited the identical declaration at identical strength.
  // The UI prints it verbatim, so an explicitly requested review rendered
  // "0% confidence".
  //
  // The layer is `declared` for the same reason: it records what produced the
  // LABEL, and that is the parent's declaration — not the structural mix, which
  // argued for a different phase entirely.
  return {
    phase: declaredPrior.phase,
    confidence: Math.min(declaredPrior.confidence, CARRIED_CONFIDENCE),
    layers: [EvidenceLayer.Declared],
  };
}

/**
 * True when a subagent's own evidence is INCOMPATIBLE with the parent's declared
 * phase, so the prior must not apply.
 *
 * The test is the subagent's OWN ARGMAX, not the presence of any one signal: it
 * contradicts a declared `review` only when its evidence independently scores
 * `implement`. An agent that actually built something was not reviewing; an agent
 * that read 44 files and touched one was.
 *
 * That distinction is not academic — it is the whole rule. Keying on "any source
 * mutation" instead, one reviewer in an 18-agent fleet carried `mutate_code=1`
 * among 44 reads, so it alone stayed `explore` while its peers became `review`.
 * Because parallel fleet turns INTERLEAVE in the parent timeline and runs group
 * by purpose PHASE, that single disagreement broke the run at nearly every turn:
 * 27 segments became 288, 202 of them sub-2s, undoing AA-12's sliver hygiene
 * wholesale. A prior that is not applied UNIFORMLY across a fleet is worse than
 * no prior at all.
 *
 * `rework` has no contradiction case: editing is what rework IS, and a read-only
 * helper inside a rework arc is still doing rework.
 */
function contradictsPrior(
  ownPhase: ActivityPhase,
  prior: ActivityPhase
): boolean {
  return (
    prior === ACTIVITY_PHASE.Review && ownPhase === ACTIVITY_PHASE.Implement
  );
}

/** Parse a subagent's own turn timestamps (finite epoch-ms), deduped + sorted.
 * Delegates to the shared `sortedUniqueMs` SSOT so this and the parent/classifier
 * variants cannot drift on the dedup rule. */
function subagentTurnMs(subagent: NormalizedSubagent): number[] {
  return sortedUniqueMs(subagent.tokenSeries ?? []);
}

/** The parent session's own unique, sorted turn timestamps — the SAME set the
 * FEA-2269 tiling is built from, so a subagent turn folded into the parent series
 * is found here and the run-walk sees every intervening main/other-subagent turn. */
function parentTurnMs(session: NormalizedSession): number[] {
  return sortedUniqueMs(session.tokenSeries ?? []);
}

/**
 * Claim each subagent turn timestamp to a subagent purpose. Subagents are visited
 * in ascending id order and the FIRST to claim a timestamp keeps it — the
 * deterministic Q-007 tie-break for the (rare) exact-timestamp collision across
 * parallel subagents. A subagent whose purpose is the honest `other` bucket
 * (unknown/low-signal tools) claims nothing: its spend is LEFT in the main-agent
 * tiling rather than re-filed to a meaningless `other` segment, which would only
 * degrade coverage.
 */
function buildClaimMap(
  subagents: readonly NormalizedSubagent[],
  harness: Harness,
  declaredPriorAt: (atMs: number) => DeclaredPrior | null
): Map<number, TurnClaim> {
  // Code-point order, NOT localeCompare: the tie-break must be identical across
  // platforms (ICU collation differs macOS↔Linux), or a session's segment
  // attribution — and its frozen golden snapshot — would depend on the host OS.
  const ordered = [...subagents].sort((a, b) => {
    if (a.id < b.id) {
      return -1;
    }
    return a.id > b.id ? 1 : 0;
  });
  const claim = new Map<number, TurnClaim>();
  for (const subagent of ordered) {
    const turns = subagentTurnMs(subagent);
    // The prior is read at the subagent's ENTRY, not over its whole span: it
    // answers "what was declared when this was dispatched", so a subagent that
    // outlives the declaration must not retroactively re-label the work it did
    // before one existed, nor carry a review through a later transition. The
    // first own turn stands in for spawn, which the normalized contract does not
    // carry. (An earlier revision read the longest-overlapping phase across the
    // whole span, on the theory that a point lookup would hand adjacent fleet
    // members different priors and shatter their shared run; measured over the
    // corpus the two agree exactly, and the run-shattering that motivated it came
    // from the contradiction rule, not from this lookup.)
    const prior = turns.length === 0 ? null : declaredPriorAt(turns[0]);
    const purpose = classifySubagentPurpose(subagent, harness, prior);
    // An `other` purpose with no prior still claims nothing: re-filing it to a
    // meaningless `other` segment would only fragment the tiling. With a prior it
    // is no longer meaningless — the parent said what this work was.
    if (purpose.phase === ACTIVITY_PHASE.Other) {
      continue;
    }
    for (const ms of turns) {
      if (!claim.has(ms)) {
        claim.set(ms, { subagentId: subagent.id, purpose });
      }
    }
  }
  return claim;
}

/**
 * Walk the parent session's turn timestamps in order, grouping maximal runs of
 * consecutive subagent-claimed turns that share the same PURPOSE PHASE into one
 * `[startMs, endMs)` span — regardless of WHICH subagent produced each turn. A main
 * turn (unclaimed) always breaks the run, so a span never engulfs main-agent spend;
 * a different-PURPOSE subagent turn also breaks it. Grouping by phase (not by
 * subagent id) is what keeps a heavily-delegated session — where consecutive turns
 * come from many different same-purpose subagents — from shattering into one tiny
 * segment per turn: they collapse to one purpose segment, and the token-free gaps
 * between those turns (which contain no main turn, or the run would have broken) are
 * absorbed rather than left as empty main-phase slivers. `subagentId`/confidence/
 * layers are taken from the run's FIRST contributor — a deterministic representative
 * of the delegated spend for the provenance marker. `endMs` is one ms past the run's
 * last turn (half-open, excludes the next turn).
 */
function spansFromClaims(
  session: NormalizedSession,
  claim: Map<number, TurnClaim>
): SubagentSpan[] {
  const entries = parentTurnMs(session).map((ms) => ({
    ms,
    claim: claim.get(ms) ?? null,
  }));
  const spans: SubagentSpan[] = [];
  let i = 0;
  while (i < entries.length) {
    const head = entries[i];
    if (!head.claim) {
      i++;
      continue;
    }
    const { subagentId, purpose } = head.claim;
    let j = i + 1;
    while (
      j < entries.length &&
      entries[j].claim?.purpose.phase === purpose.phase
    ) {
      j++;
    }
    // Contiguous end: butt the span up against the breaking entry's ms (a main turn
    // or a different-purpose subagent turn), or one ms past the final turn at
    // end-of-list. Because a main turn always breaks the run, everything the span
    // absorbs between its turns is token-free — so extending to the breaker never
    // misattributes main spend, and it leaves NO empty main-phase sliver between
    // adjacent runs (the defect a tight `lastMs + 1` end would create at every
    // subagent phase transition).
    const endMs = j < entries.length ? entries[j].ms : entries[j - 1].ms + 1;
    spans.push({
      startMs: head.ms,
      endMs,
      subagentId,
      phase: purpose.phase,
      confidence: purpose.confidence,
      layers: purpose.layers,
    });
    i = j;
  }
  return spans;
}

/** The subagent purpose spans for a session (empty when no subagent claims a
 * classifiable, folded turn — the common no-subagent / non-Claude-harness case,
 * which degrades to the unchanged FEA-2269 + FEA-2270 tiling). */
export function computeSubagentSpans(
  session: NormalizedSession,
  harness: Harness,
  declaredPriorAt: (atMs: number) => DeclaredPrior | null = () => null
): SubagentSpan[] {
  const claim = buildClaimMap(
    session.subagents ?? [],
    harness,
    declaredPriorAt
  );
  if (claim.size === 0) {
    return [];
  }
  return spansFromClaims(session, claim);
}

/**
 * Re-file each subagent's folded spend to its own purpose phase. For every
 * non-`idle` segment overlapping a subagent span, split at the span's exact turn
 * boundaries and relabel only the covered slice to the subagent's purpose +
 * `subagentId` provenance; adjacent same-owner slices are then coalesced back into
 * one run (restoring FEA-2269's maximal-run shape). Splitting only subdivides an
 * existing interval — it never moves an FEA-2269/2270 boundary, reassigns a turn, or
 * changes total spend — so complete-tiling and Σ-reconciliation hold. Generic over
 * the concrete record type so this module never imports the classifier (no cycle).
 */
export function applySubagentPurposeAttribution<T extends SubagentRelabelable>(
  segments: readonly T[],
  session: NormalizedSession,
  harness: Harness
): T[] {
  const spans = computeSubagentSpans(
    session,
    harness,
    declaredPriorLookup(segments)
  );
  if (spans.length === 0) {
    return [...segments];
  }
  const relabelled: T[] = [];
  for (const seg of segments) {
    if (seg.phase === ACTIVITY_PHASE.Idle) {
      relabelled.push(seg);
      continue;
    }
    for (const piece of splitAtCuts(seg, interiorCuts(seg, spans))) {
      const span = containingSpan(piece, spans);
      relabelled.push(
        span
          ? {
              ...piece,
              phase: span.phase,
              confidence: span.confidence,
              evidenceLayers: [...span.layers],
              subagentId: span.subagentId,
            }
          : piece
      );
    }
  }
  // Shared provenance-aware run identity (SSOT in activity-segment-relabel):
  // subagent-owned slices never coalesce with adjacent main-agent slices of the
  // same label, and different subagents' same-phase slices stay distinct.
  return coalesceAdjacentRuns(relabelled, sameRunByProvenance);
}

/**
 * A lookup for the parent's DECLARED phase at an instant, built from the tiling
 * this pass was handed.
 *
 * This pass runs AFTER the rework and phase-carry passes, so those segments
 * already carry whatever the session declared.
 *
 * The PHASE alone is the test — the `declared` evidence layer is deliberately NOT
 * required. `review` and `rework` are declared-only phases: `activity-scoring.ts`
 * never produces either, so a segment carrying one always traces to a request or
 * an address-review prompt. A CARRIED review is that same declaration still in
 * flight, and AA-05 empties its layers precisely because the label is inherited.
 *
 * Requiring the layer was measured and rejected: it admitted only the two short
 * windows sitting exactly on the request instants, so within one interleaved
 * 18-agent fleet some members got the prior and others did not. Because runs
 * group by purpose PHASE, that disagreement broke the run at nearly every turn —
 * 27 segments became 288, of which 202 were sub-2s, undoing AA-12's sliver
 * hygiene wholesale.
 *
 * The declaring segment's CONFIDENCE comes back with the phase, because that is
 * the strength the inherited label actually rests on (see
 * {@link classifySubagentPurpose}).
 */
function declaredPriorLookup<T extends SubagentRelabelable>(
  segments: readonly T[]
): (atMs: number) => DeclaredPrior | null {
  const declared = segments.filter((seg) =>
    DECLARED_PRIOR_PHASES.has(seg.phase)
  );
  if (declared.length === 0) {
    return () => null;
  }
  // The segment CONTAINING the instant. The tiling is a partition, so at most one
  // matches and no tie-break is needed.
  return (atMs: number) => {
    for (const seg of declared) {
      if (atMs >= seg.startMs && atMs < seg.endMs) {
        return { phase: seg.phase, confidence: seg.confidence };
      }
    }
    return null;
  };
}
