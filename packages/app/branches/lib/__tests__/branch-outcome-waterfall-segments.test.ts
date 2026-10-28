import {
  type BranchPhaseAttributionSegment,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it } from "vitest";
import { countPredicateInvocations } from "../../__tests__/branch-scan-instrumentation";
import {
  visibleOutcomeSegments,
  type WaterfallSegment,
} from "../branch-outcome-waterfall-segments";

const LADDER_SEGMENT_COUNT = 400;
const LADDER_STRIDE_MS = 20;
const LADDER_ACTIVE_MS = 10;

describe("visibleOutcomeSegments", () => {
  it("gives overlapped time to the highest-precedence phase", () => {
    expect(
      visibleOutcomeSegments(
        [
          phaseSegment(BranchVisibleLifecyclePhase.Build, 0, 90),
          phaseSegment(BranchVisibleLifecyclePhase.Review, 45, 135),
          phaseSegment(BranchVisibleLifecyclePhase.Rework, 75, 150),
        ],
        0,
        150
      )
    ).toEqual([
      { durationMs: 45, type: BranchVisibleLifecyclePhase.Build },
      { durationMs: 30, type: BranchVisibleLifecyclePhase.Review },
      { durationMs: 75, type: BranchVisibleLifecyclePhase.Rework },
    ]);
  });

  it("clips to the cycle window and calls the uncovered time idle", () => {
    expect(
      visibleOutcomeSegments(
        [
          phaseSegment(BranchVisibleLifecyclePhase.Build, 50, 120),
          phaseSegment(BranchVisibleLifecyclePhase.Review, 160, 250),
          phaseSegment(BranchVisibleLifecyclePhase.Rework, 400, 500),
        ],
        100,
        200
      )
    ).toEqual([
      { durationMs: 20, type: BranchVisibleLifecyclePhase.Build },
      { durationMs: 40, type: "idle" },
      { durationMs: 40, type: BranchVisibleLifecyclePhase.Review },
    ]);
  });

  it("coalesces abutting same-phase segments and keeps the gap between them", () => {
    expect(
      visibleOutcomeSegments(
        [
          phaseSegment(BranchVisibleLifecyclePhase.Build, 0, 50),
          phaseSegment(BranchVisibleLifecyclePhase.Build, 50, 100),
          phaseSegment(BranchVisibleLifecyclePhase.Build, 150, 200),
        ],
        0,
        200
      )
    ).toEqual([
      { durationMs: 100, type: BranchVisibleLifecyclePhase.Build },
      { durationMs: 50, type: "idle" },
      { durationMs: 50, type: BranchVisibleLifecyclePhase.Build },
    ]);
  });

  it("reports a cycle with no attributed evidence as wholly idle", () => {
    expect(visibleOutcomeSegments([], 100, 400)).toEqual([
      { durationMs: 300, type: "idle" },
    ]);
  });

  /**
   * ISS-7039: the pin, for the exact shape the fix removed. The resolver this
   * replaced walked the same boundary list and produced the same slices, so
   * asserting the slices could never have caught it; what was quadratic was HOW
   * it resolved each interval — a `PHASE_PRECEDENCE.find(...)` whose predicate
   * re-scanned every clipped segment with `.some(...)`. At N=400 that ran
   * roughly 722,000 array predicates; the sweep runs none.
   *
   * This counts predicates dispatched through `filter`/`find`/`findIndex`/
   * `some` and NOTHING ELSE; `branch-scan-instrumentation.ts` states what that
   * leaves uncovered. The panel suite asserts the same bound through a rendered
   * `BranchLeadTimeWaterfall`, so the production wiring is pinned too.
   */
  it("resolves phases without a find/some rescan per boundary", () => {
    const source = ladderSegments(LADDER_SEGMENT_COUNT);
    let segments: WaterfallSegment[] = [];

    const invocations = countPredicateInvocations(() => {
      segments = visibleOutcomeSegments(
        source,
        0,
        LADDER_SEGMENT_COUNT * LADDER_STRIDE_MS
      );
    });

    expect(segments.length).toBeGreaterThan(LADDER_SEGMENT_COUNT);
    expect(invocations).toBeLessThanOrEqual(LADDER_SEGMENT_COUNT);
  });
});

/** `count` short phases separated by idle gaps, cycling the three phases. */
function ladderSegments(count: number): BranchPhaseAttributionSegment[] {
  const phases = Object.values(BranchVisibleLifecyclePhase);
  return Array.from({ length: count }, (_unused, index) =>
    phaseSegment(
      phases[index % phases.length] ?? BranchVisibleLifecyclePhase.Build,
      index * LADDER_STRIDE_MS,
      index * LADDER_STRIDE_MS + LADDER_ACTIVE_MS
    )
  );
}

function phaseSegment(
  phase: BranchVisibleLifecyclePhase,
  startMs: number,
  endMs: number
): BranchPhaseAttributionSegment {
  return {
    sessionId: `${phase}-${startMs}`,
    sequence: 0,
    phase,
    startMs,
    endMs,
    estimatedCostUsd: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    evidenceIds: [],
  };
}
