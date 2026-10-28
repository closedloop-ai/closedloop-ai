import {
  type BranchPhaseAttributionSegment,
  BranchVisibleLifecyclePhase,
  type BranchVisibleLifecyclePhase as VisiblePhase,
} from "@repo/api/src/types/branch-phase-attribution";

/** One contiguous slice of the selected-cycle waterfall. */
export type WaterfallSegment = {
  durationMs: number;
  type: VisiblePhase | "idle";
};

/**
 * Which phase owns an instant covered by more than one attribution segment.
 * Rework wins over Review, which wins over Build.
 */
const PHASE_PRECEDENCE: readonly VisiblePhase[] = [
  BranchVisibleLifecyclePhase.Rework,
  BranchVisibleLifecyclePhase.Review,
  BranchVisibleLifecyclePhase.Build,
];

/** A clipped segment opening (`+1`) or closing (`-1`) at `atMs`. */
type PhaseEdge = {
  atMs: number;
  delta: number;
  phase: VisiblePhase;
};

/**
 * ISS-7039: the selected cycle's Build / Review / Rework / Idle slices, resolved
 * by ONE sweep rather than a rescan per boundary.
 *
 * `attribution.segments` is the branch's per-session phase attribution, so N is
 * data-driven — a long-lived branch carries a segment per session, bounded only
 * by the desktop's 50,000-row cohort cap. Resolving each boundary interval by
 * re-scanning every clipped segment for an overlap made the sweep O(N^2) even
 * though each individual pass read as linear. Walking the sorted edges once and
 * keeping a live count per phase (there are only three) is O(N log N) — the sort
 * — and produces the same slices: the boundary list already holds every clipped
 * start and end, so an edge at or before an interval's start is exactly an edge
 * that has already opened or closed by the time that interval begins.
 */
export function visibleOutcomeSegments(
  source: readonly BranchPhaseAttributionSegment[],
  startMs: number,
  endMs: number
): WaterfallSegment[] {
  const edges = clippedPhaseEdges(source, startMs, endMs);
  const boundaries = [
    ...new Set([startMs, endMs, ...edges.map((edge) => edge.atMs)]),
  ].sort(ascending);
  const active = new Map<VisiblePhase, number>();
  const result: WaterfallSegment[] = [];
  let next = 0;
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (!(start !== undefined && end !== undefined && end > start)) {
      continue;
    }
    while (next < edges.length) {
      const edge = edges[next];
      if (!edge || edge.atMs > start) {
        break;
      }
      active.set(edge.phase, (active.get(edge.phase) ?? 0) + edge.delta);
      next += 1;
    }
    appendSegment(result, dominantPhase(active) ?? "idle", end - start);
  }
  return result;
}

function clippedPhaseEdges(
  source: readonly BranchPhaseAttributionSegment[],
  startMs: number,
  endMs: number
): PhaseEdge[] {
  const edges: PhaseEdge[] = [];
  for (const segment of source) {
    const start = Math.max(startMs, segment.startMs);
    const end = Math.min(endMs, segment.endMs);
    if (end > start) {
      edges.push(
        { atMs: start, delta: 1, phase: segment.phase },
        { atMs: end, delta: -1, phase: segment.phase }
      );
    }
  }
  return edges.sort((left, right) => left.atMs - right.atMs);
}

/** Highest-precedence phase currently covering the sweep position. */
function dominantPhase(
  active: ReadonlyMap<VisiblePhase, number>
): VisiblePhase | undefined {
  for (const phase of PHASE_PRECEDENCE) {
    if ((active.get(phase) ?? 0) > 0) {
      return phase;
    }
  }
  return undefined;
}

function appendSegment(
  target: WaterfallSegment[],
  type: WaterfallSegment["type"],
  durationMs: number
): void {
  const previous = target.at(-1);
  if (previous?.type === type) {
    previous.durationMs += durationMs;
  } else {
    target.push({ durationMs, type });
  }
}

function ascending(left: number, right: number): number {
  return left - right;
}
