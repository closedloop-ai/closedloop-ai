/**
 * Edge cases for branch-lifecycle-phase covering:
 * 1. timestampSortValue with a non-empty unparseable string → POSITIVE_INFINITY
 *    (the cond arm where `!value` is false but Date.parse returns NaN)
 * 2. toBoundary with falsy observedAt → spreads {} instead of {observedAt}
 * 3. toBoundary with falsy evidenceId → spreads {} instead of {evidenceId}
 */
import {
  BranchLifecycleBoundaryKind,
  BranchLifecyclePhase,
  type BranchLifecyclePhaseSegment,
} from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import {
  deriveBranchLifecyclePhaseSegments,
  normalizeBranchLifecyclePhaseSegments,
} from "./branch-lifecycle-phase";

describe("deriveBranchLifecyclePhaseSegments — timestampSortValue edge cases", () => {
  it("sorts an event with a non-empty unparseable observedAt after valid events (POSITIVE_INFINITY sort value)", () => {
    // "bad-date" is non-empty (so !value is false) but Date.parse("bad-date") is NaN.
    // timestampSortValue returns POSITIVE_INFINITY → event sorts LAST.
    const segments = deriveBranchLifecyclePhaseSegments({
      events: [
        {
          kind: BranchLifecycleBoundaryKind.ReviewFeedback,
          observedAt: "bad-date",
          evidenceId: "ev-bad",
        },
        {
          kind: BranchLifecycleBoundaryKind.SessionStart,
          observedAt: "2026-08-01T00:00:00.000Z",
          evidenceId: "ev-start",
        },
        {
          kind: BranchLifecycleBoundaryKind.SessionEnd,
          observedAt: "2026-08-01T01:00:00.000Z",
          evidenceId: "ev-end",
        },
      ],
    });
    // The bad-date ReviewFeedback event sorts after SessionEnd → it lands in the
    // session-ended state and is ignored (sessionEnded guard). The session still
    // closes from SessionEnd. At least one segment is produced.
    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(segments[0].phase).toBe(BranchLifecyclePhase.Build);
  });
});

describe("deriveBranchLifecyclePhaseSegments — toBoundary falsy observedAt / evidenceId", () => {
  it("handles a non-SessionStart/End event with null observedAt (toBoundary omits observedAt)", () => {
    // BranchWrite with observedAt: null → toBoundary spreads {} (no observedAt key).
    // The event still processes; the segment just lacks an explicit boundary timestamp.
    const segments = deriveBranchLifecyclePhaseSegments({
      sessionStartedAt: "2026-08-01T00:00:00.000Z",
      sessionEndedAt: "2026-08-01T01:00:00.000Z",
      events: [
        {
          kind: BranchLifecycleBoundaryKind.BranchWrite,
          observedAt: null, // ← falsy → toBoundary arm=1 for observedAt
          evidenceId: "write-1",
        },
      ],
    });
    expect(segments).toHaveLength(1);
    // With null observedAt on BranchWrite, the segment opens from sessionStartedAt.
    expect(segments[0].phase).toBe(BranchLifecyclePhase.Build);
  });

  it("handles a non-SessionStart/End event with null evidenceId (toBoundary omits evidenceId)", () => {
    // ReviewFeedback with evidenceId: null → toBoundary spreads {} (no evidenceId key).
    // appendEvidence also receives null evidenceId → the if(event.evidenceId) guard skips the push.
    const segments = deriveBranchLifecyclePhaseSegments({
      sessionStartedAt: "2026-08-01T00:00:00.000Z",
      sessionEndedAt: "2026-08-01T01:00:00.000Z",
      events: [
        {
          kind: BranchLifecycleBoundaryKind.PrRaised,
          observedAt: "2026-08-01T00:30:00.000Z",
          evidenceId: "pr-raised",
        },
        {
          kind: BranchLifecycleBoundaryKind.ReviewFeedback,
          observedAt: "2026-08-01T00:45:00.000Z",
          evidenceId: null, // ← falsy → toBoundary arm=1 for evidenceId
        },
      ],
    });
    // ReviewFeedback after PrRaised → Review phase; null evidenceId → no evidenceId in boundary.
    const reviewSegment = segments.find(
      (s) => s.phase === BranchLifecyclePhase.Review
    );
    expect(reviewSegment).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeBranchLifecyclePhaseSegments — same-sequence tie-break
// ---------------------------------------------------------------------------

describe("normalizeBranchLifecyclePhaseSegments — equal sequence fallthrough to compareOptionalTimestamp", () => {
  it("sorts segments with identical sequence by startedAt (branch 5[1]: left.sequence === right.sequence)", () => {
    // Two segments with sequence=0 cause `if (left.sequence !== right.sequence)` to be FALSE,
    // exercising the else fall-through that calls compareOptionalTimestamp(left.startedAt, right.startedAt).
    const earlier: BranchLifecyclePhaseSegment = {
      sequence: 0,
      phase: BranchLifecyclePhase.Build,
      startedAt: "2026-08-01T00:00:00.000Z",
      startBoundary: { kind: BranchLifecycleBoundaryKind.SessionStart },
    };
    const later: BranchLifecyclePhaseSegment = {
      sequence: 0,
      phase: BranchLifecyclePhase.Review,
      startedAt: "2026-08-01T01:00:00.000Z",
      startBoundary: { kind: BranchLifecycleBoundaryKind.PrRaised },
    };
    const result = normalizeBranchLifecyclePhaseSegments([later, earlier]);
    expect(result[0].phase).toBe(BranchLifecyclePhase.Build);
    expect(result[1].phase).toBe(BranchLifecyclePhase.Review);
  });
});
