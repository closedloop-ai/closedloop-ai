import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { BRANCH_PUSH_METHOD_VALUES } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import { projectBranchPhaseAttribution } from "./branch-phase-attribution";

const T = 1_700_000_000_000;
const PUSH_METHOD = BRANCH_PUSH_METHOD_VALUES[0];
const NON_PUSH_METHOD = "local_commit";

function iso(offsetMs: number): string {
  return new Date(T + offsetMs).toISOString();
}

function seg(costUsd: number | null, inputTokens = 10) {
  return {
    phase: BranchVisibleLifecyclePhase.Build,
    startMs: T,
    endMs: T + 10_000,
    costUsd,
    inputTokens,
    outputTokens: 0,
    confidence: 0.9,
  };
}

function writeAt(offsetMs: number, method: string = PUSH_METHOD) {
  return {
    kind: BranchLifecycleBoundaryKind.BranchWrite,
    observedAt: iso(offsetMs),
    method,
  };
}

function reviewAt(offsetMs: number) {
  return {
    kind: BranchLifecycleBoundaryKind.ReviewFeedback,
    observedAt: iso(offsetMs),
  };
}

describe("projectBranchPhaseAttribution — duplicate session rows", () => {
  it("keeps a divisor-less session skipped when a later row supplies a branch count", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        { sessionId: "s1", estimatedCostUsd: 2, activitySegments: [seg(2)] },
        { sessionId: "s1", branchCount: 1, lifecycleEvents: [writeAt(1000)] },
      ],
      pullRequestCycles: [],
    });
    expect(result.segments).toEqual([]);
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.MissingBranchDivisor,
    });
  });

  it("adopts a later row's non-Wrote participation when the first row had none", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          branchCount: 1,
          estimatedCostUsd: 2,
          activitySegments: [seg(2)],
          lifecycleEvents: [writeAt(1000)],
        },
        {
          sessionId: "s1",
          branchCount: 1,
          participation: BranchParticipationKind.Reviewed,
        },
      ],
      pullRequestCycles: [],
    });
    expect(result.segments).toEqual([]);
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.LifecycleIncomplete,
    });
  });

  it("takes segments from a later row when the first row carried none", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          branchCount: 1,
          participation: BranchParticipationKind.Wrote,
        },
        {
          sessionId: "s1",
          branchCount: 1,
          activitySegments: [seg(2)],
          lifecycleEvents: [writeAt(1000)],
        },
      ],
      pullRequestCycles: [],
    });
    expect(result.segments.map((segment) => segment.phase)).toEqual([
      BranchVisibleLifecyclePhase.Build,
    ]);
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 2,
    });
  });
});

describe("projectBranchPhaseAttribution — optional fields", () => {
  it("reports Complete for a session with neither segments nor a cost", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [{ sessionId: "s1", branchCount: 1 }],
      pullRequestCycles: [],
    });
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 0,
    });
  });

  it("defaults absent cache tokens to 0, dedupes an identical legacy segment, and emits no evidence ids for id-less events", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          branchCount: 1,
          participation: BranchParticipationKind.Wrote,
          activitySegments: [seg(2), seg(2)],
          lifecycleEvents: [
            writeAt(1000),
            { ...writeAt(1000), evidenceId: null },
          ],
        },
      ],
      pullRequestCycles: [],
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      evidenceIds: [],
    });
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 2,
    });
  });

  it("treats an unpriced segment with no tokens and no cache fields as carrying no spend", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          branchCount: 1,
          participation: BranchParticipationKind.Wrote,
          activitySegments: [seg(null, 0)],
          lifecycleEvents: [writeAt(1000)],
        },
      ],
      pullRequestCycles: [],
    });
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 0,
    });
  });
});

describe("projectBranchPhaseAttribution — phase decisions", () => {
  it("refuses a segment whose review feedback spans two PR cycles", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          branchCount: 1,
          participation: BranchParticipationKind.Wrote,
          activitySegments: [seg(2)],
          lifecycleEvents: [reviewAt(1000), reviewAt(4000)],
        },
      ],
      pullRequestCycles: [
        { pullRequestId: "pr-1", openedAt: iso(0), terminalAt: iso(2000) },
        { pullRequestId: "pr-2", openedAt: iso(3000), terminalAt: null },
      ],
    });
    expect(result.segments).toEqual([]);
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.AmbiguousEvidence,
    });
  });

  it("refuses a non-push write inside an open cycle after it opened", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          branchCount: 1,
          participation: BranchParticipationKind.Wrote,
          activitySegments: [seg(2)],
          lifecycleEvents: [writeAt(1000, NON_PUSH_METHOD)],
        },
      ],
      pullRequestCycles: [
        { pullRequestId: "pr-1", openedAt: iso(0), terminalAt: null },
      ],
    });
    expect(result.segments).toEqual([]);
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.LifecycleIncomplete,
    });
  });

  it("orders segments with identical intervals by session id", () => {
    const session = (sessionId: string) => ({
      sessionId,
      branchCount: 1,
      participation: BranchParticipationKind.Wrote,
      activitySegments: [seg(2)],
      lifecycleEvents: [writeAt(1000)],
    });
    const result = projectBranchPhaseAttribution({
      sessions: [session("s-b"), session("s-a")],
      pullRequestCycles: [],
    });
    expect(result.segments.map((segment) => segment.sessionId)).toEqual([
      "s-a",
      "s-b",
    ]);
  });
});
