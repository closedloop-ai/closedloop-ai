/**
 * @file activity-segment-relabel.ts
 * @description PRD-488 shared, PURE tiling-relabel primitives used by the
 * post-passes that refine the FEA-2269 structural tiling IN PLACE — FEA-2270
 * (rework) and FEA-2271 (subagent purpose attribution). Both take the completed
 * `[startMs, endMs)` tiling and relabel a subset of it to a target phase, splitting
 * only at exact span boundaries so complete-tiling and Σ(segment spend) ==
 * session-total are preserved: a split just subdivides one interval of the existing
 * contiguous tiling; it never moves an FEA-2269 boundary, reassigns a turn, or
 * invents time.
 *
 * Extracted from rework-detector.ts so the two post-passes share ONE
 * split/coalesce implementation (SSOT) instead of each carrying a copy. Also the
 * home of `sortedUniqueMs`, the turn-timestamp dedup/sort SSOT the FEA-2269 tiler
 * and both post-passes share. Leaf module: imports only the taxonomy phase type,
 * so the post-passes and the classifier that consume it cannot cycle through it.
 */
import type { ActivityPhase } from "./activity-taxonomy.js";

/**
 * Parse a token/turn stream's timestamps to finite epoch-ms, de-duplicated and
 * ascending — the SSOT for "the sorted unique turn instants" the FEA-2269 tiler
 * and both post-passes build boundaries from. Extracted here (the shared leaf) so
 * the classifier's whole-session variant, and the subagent post-pass's per-subagent
 * and per-parent variants, delegate to ONE dedup/sort rule instead of each carrying
 * a byte-identical copy that could silently drift. Callers that need a sub-range
 * (e.g. the classifier clamps to a segment's `[startMs, endMs]`) filter the result.
 */
export function sortedUniqueMs(
  records: readonly { timestamp: string }[]
): number[] {
  const seen = new Set<number>();
  for (const record of records) {
    const ms = Date.parse(record.timestamp);
    if (Number.isFinite(ms)) {
      seen.add(ms);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Parse a single ISO timestamp to finite epoch-ms, or `null` when absent or
 * unparseable. The scalar sibling of {@link sortedUniqueMs}: the SSOT both declared
 * post-passes ({@link ../rework-detector} and {@link ../review-intent-detector})
 * read a message/command instant with, instead of each carrying a byte-identical
 * copy that could silently drift.
 */
export function parseMsOrNull(iso: string | null | undefined): number | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** A half-open `[startMs, endMs)` interval the relabel machinery cuts/queries. */
export type Span = { startMs: number; endMs: number };

/**
 * The minimal segment shape the relabel reads/writes — a structural subset of
 * FEA-2269's `ActivitySegmentRecord`, so this module needs no import from (and
 * cannot cycle with) the classifier that consumes it. A concrete post-pass keeps
 * its full record type via the generic `T`.
 */
export type RelabelableSegment = {
  phase: ActivityPhase;
  startMs: number;
  endMs: number;
  confidence: number;
  evidenceLayers: string[];
};

/**
 * The span boundaries that fall STRICTLY inside `[seg.startMs, seg.endMs)` — the
 * points at which the segment must be split so only its covered slice is
 * relabelled. Ascending, de-duplicated.
 */
export function interiorCuts(seg: Span, spans: readonly Span[]): number[] {
  const cuts = new Set<number>();
  for (const span of spans) {
    if (span.startMs > seg.startMs && span.startMs < seg.endMs) {
      cuts.add(span.startMs);
    }
    if (span.endMs > seg.startMs && span.endMs < seg.endMs) {
      cuts.add(span.endMs);
    }
  }
  return [...cuts].sort((a, b) => a - b);
}

/**
 * Tile a segment into contiguous pieces at the given interior cut points, each
 * carrying the original segment's fields (so `version`/`workItemRef`/etc. ride
 * along and each piece still hashes to a unique id from its distinct start_ms).
 */
export function splitAtCuts<T extends Span>(seg: T, cuts: number[]): T[] {
  if (cuts.length === 0) {
    return [seg];
  }
  const pieces: T[] = [];
  let start = seg.startMs;
  for (const cut of cuts) {
    pieces.push({ ...seg, startMs: start, endMs: cut });
    start = cut;
  }
  pieces.push({ ...seg, startMs: start, endMs: seg.endMs });
  return pieces;
}

/**
 * The span that fully contains this (post-split) piece, if any. After splitting at
 * span boundaries every piece is wholly inside or wholly outside every span.
 */
export function containingSpan<S extends Span>(
  piece: Span,
  spans: readonly S[]
): S | undefined {
  return spans.find(
    (span) => piece.startMs >= span.startMs && piece.endMs <= span.endMs
  );
}

/**
 * Two relabelled pieces belong to the same run when phase, confidence, and
 * evidence-layer provenance all match — the attributes an FEA-2269 same-phase run
 * holds constant. A post-pass that adds provenance beyond these base fields (e.g.
 * FEA-2271's `subagentId`) composes this with its own equality.
 */
export function sameRunByLabel(
  a: RelabelableSegment,
  b: RelabelableSegment
): boolean {
  return (
    a.phase === b.phase &&
    a.confidence === b.confidence &&
    a.evidenceLayers.length === b.evidenceLayers.length &&
    a.evidenceLayers.every((layer, i) => layer === b.evidenceLayers[i])
  );
}

/**
 * Merge adjacent pieces that belong to the same run, restoring FEA-2269's
 * maximal-same-phase-run invariant (its tiler never emits two adjacent segments
 * sharing a phase). `sameRun` decides run identity — rework passes
 * {@link sameRunByLabel}; a post-pass carrying extra provenance passes a predicate
 * that also compares it. Merging keeps the first piece's fields and extends its
 * end, so the tiling stays complete/contiguous and total spend is unchanged.
 * Pieces that are NOT same-run (e.g. two rework slices from different spans with
 * distinct confidence, or two adjacent segments owned by different subagents) keep
 * their boundary and are intentionally not merged.
 */
export function coalesceAdjacentRuns<T extends RelabelableSegment>(
  pieces: readonly T[],
  sameRun: (a: T, b: T) => boolean
): T[] {
  const merged: T[] = [];
  for (const piece of pieces) {
    const prev = merged.at(-1);
    if (prev && prev.endMs === piece.startMs && sameRun(prev, piece)) {
      merged[merged.length - 1] = { ...prev, endMs: piece.endMs };
    } else {
      merged.push(piece);
    }
  }
  return merged;
}

/**
 * The provenance-aware run identity every post-pass that carries delegated-spend
 * (`subagentId`) or work-item (`workItemRef`) provenance shares — {@link
 * sameRunByLabel} PLUS equality of both provenance axes. So a subagent-owned slice
 * never coalesces with (or gets absorbed into) an adjacent main-agent slice of the
 * same label, and two different subagents' / work-items' same-phase slices stay
 * distinct. Both axes are optional (null-normalized), so a record type that omits
 * one still satisfies the constraint. The SSOT for this primitive family
 * (FEA-2271's subagent pass and AA-12's sliver merge both use it) — extending it
 * once here rather than re-hand-rolling the `&&` chain at each call site.
 */
export function sameRunByProvenance<
  T extends RelabelableSegment & {
    subagentId?: string | null;
    workItemRef?: string | null;
  },
>(a: T, b: T): boolean {
  return (
    sameRunByLabel(a, b) &&
    (a.subagentId ?? null) === (b.subagentId ?? null) &&
    (a.workItemRef ?? null) === (b.workItemRef ?? null)
  );
}
