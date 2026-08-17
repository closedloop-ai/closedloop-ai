import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it } from "vitest";
import { expectIncompleteCoverage } from "./__tests__/coverage-narrowing";
import { projectBranchPhaseAttribution } from "./branch-phase-attribution";

// Epoch anchor for all tests in this file.
const T = 1_700_000_000_000;

function iso(offsetMs: number): string {
  return new Date(T + offsetMs).toISOString();
}

// Helpers with NO default parameters so they add zero branches to the denominator.

function seg(startMs: number, endMs: number, costUsd: number) {
  return {
    phase: "build",
    startMs,
    endMs,
    costUsd,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    confidence: 0.9,
  };
}

function segWithId(
  startMs: number,
  endMs: number,
  costUsd: number,
  sourceId: string
) {
  return {
    phase: "build",
    startMs,
    endMs,
    costUsd,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    confidence: 0.9,
    sourceEventIds: [sourceId],
  };
}

function writeEvent(offsetMs: number) {
  return {
    kind: BranchLifecycleBoundaryKind.BranchWrite,
    observedAt: iso(offsetMs),
    evidenceId: `write-${offsetMs}`,
    method: "git_push",
  };
}

describe("projectBranchPhaseAttribution edge cases — malformed inputs", () => {
  it("marks MalformedEvidence for a cycle with empty pullRequestId", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [],
      pullRequestCycles: [
        { pullRequestId: "", openedAt: iso(0), terminalAt: null },
      ],
    });
    // Empty pullRequestId → MalformedEvidence reason set; no sessions → Unavailable
    expect(result.coverage.completeness).toBe(
      BranchPhaseAttributionCompleteness.Unavailable
    );
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.MalformedEvidence
    );
  });

  it("marks MalformedEvidence for a cycle with null openedAt (also exercises parseTimestamp null path)", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [],
      pullRequestCycles: [
        { pullRequestId: "pr-1", openedAt: null, terminalAt: null },
      ],
    });
    // Null openedAt → MalformedEvidence reason set; no sessions → Unavailable
    expect(result.coverage.completeness).toBe(
      BranchPhaseAttributionCompleteness.Unavailable
    );
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.MalformedEvidence
    );
  });

  it("marks MalformedEvidence for a cycle with non-null unparseable terminalAt", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 2,
          activitySegments: [seg(T + 5000, T + 10_000, 2)],
          lifecycleEvents: [writeEvent(7000)],
        },
      ],
      pullRequestCycles: [
        {
          pullRequestId: "pr-1",
          openedAt: iso(0),
          terminalAt: "not-a-date",
        },
      ],
    });
    // Malformed cycle dropped → write event falls before no cycle → Build
    // MalformedEvidence reason is set → Partial since we have a segment
    expect(result.coverage.completeness).toBe(
      BranchPhaseAttributionCompleteness.Partial
    );
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.MalformedEvidence
    );
  });

  it("marks MalformedEvidence for a cycle where terminalAt precedes openedAt", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [],
      pullRequestCycles: [
        {
          pullRequestId: "pr-1",
          openedAt: iso(20_000),
          terminalAt: iso(5000),
        },
      ],
    });
    // terminalAt < openedAt → MalformedEvidence reason set; no sessions → Unavailable
    expect(result.coverage.completeness).toBe(
      BranchPhaseAttributionCompleteness.Unavailable
    );
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.MalformedEvidence
    );
  });

  it("marks MalformedEvidence for an invalid ambiguousWriteAfter timestamp", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [],
      pullRequestCycles: [],
      ambiguousWriteAfter: ["not-a-timestamp"],
    });
    // Invalid boundary timestamp → MalformedEvidence reason set; no sessions → Unavailable
    expect(result.coverage.completeness).toBe(
      BranchPhaseAttributionCompleteness.Unavailable
    );
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.MalformedEvidence
    );
  });

  it("marks MalformedEvidence for a session with an empty sessionId", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 5,
          activitySegments: [seg(T, T + 10_000, 5)],
          lifecycleEvents: [],
        },
      ],
      pullRequestCycles: [],
    });
    // Empty sessionId → MalformedEvidence reason set; session dropped → no segments → Unavailable
    expect(result.coverage.completeness).toBe(
      BranchPhaseAttributionCompleteness.Unavailable
    );
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.MalformedEvidence
    );
  });

  it("drops a session with a null (falsy) observedAt in lifecycle events", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 1,
          activitySegments: [seg(T, T + 10_000, 1)],
          lifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.BranchWrite,
              observedAt: null,
            },
          ],
        },
      ],
      pullRequestCycles: [],
    });
    // Null observedAt → MalformedEvidence reason takes priority over LifecycleIncomplete.
    // The event is malformed → normalizeEvents adds MalformedEvidence → highest-priority reason wins.
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.MalformedEvidence
    );
  });
});

describe("projectBranchPhaseAttribution edge cases — session merging", () => {
  it("accepts a second occurrence of the same session with identical branchCount (else-if arm)", () => {
    const sessionInput = {
      sessionId: "s1",
      participation: BranchParticipationKind.Wrote,
      branchCount: 1,
      estimatedCostUsd: 2,
      activitySegments: [seg(T, T + 10_000, 2)],
      lifecycleEvents: [writeEvent(5000)],
    };
    // Sending same session twice with same branchCount=1 should not conflict.
    const result = projectBranchPhaseAttribution({
      sessions: [sessionInput, { ...sessionInput, lifecycleEvents: [] }],
      pullRequestCycles: [],
    });
    // No AmbiguousEvidence → Complete
    expect(result.coverage.completeness).toBe(
      BranchPhaseAttributionCompleteness.Complete
    );
    expect(result.segments).toHaveLength(1);
  });

  it("resolves merged cost when existing is null and next provides a value", () => {
    // First occurrence: estimatedCostUsd null → existing.estimatedCostUsd = null
    // Second occurrence: estimatedCostUsd 3 → normalized = 3 → returns 3
    const base = {
      sessionId: "s1",
      participation: BranchParticipationKind.Wrote,
      branchCount: 1,
      estimatedCostUsd: null as number | null,
      activitySegments: [seg(T, T + 10_000, 2)],
      lifecycleEvents: [writeEvent(5000)],
    };
    const second = {
      ...base,
      estimatedCostUsd: 3,
      activitySegments: [],
      lifecycleEvents: [],
    };
    const result = projectBranchPhaseAttribution({
      sessions: [base, second],
      pullRequestCycles: [],
    });
    // No conflict, segment is projected correctly
    expect(result.coverage.completeness).toBe(
      BranchPhaseAttributionCompleteness.Complete
    );
  });

  it("marks AmbiguousEvidence when the same session has conflicting estimatedCostUsd", () => {
    const base = {
      sessionId: "s1",
      participation: BranchParticipationKind.Wrote,
      branchCount: 1,
      estimatedCostUsd: 2 as number | null,
      activitySegments: [seg(T, T + 10_000, 2)],
      lifecycleEvents: [writeEvent(5000)],
    };
    const conflict = {
      ...base,
      estimatedCostUsd: 10 as number | null,
      activitySegments: [],
      lifecycleEvents: [],
    };
    const result = projectBranchPhaseAttribution({
      sessions: [base, conflict],
      pullRequestCycles: [],
    });
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.AmbiguousEvidence
    );
  });

  it("appends activitySegments from a second occurrence of the same session", () => {
    const s1 = {
      sessionId: "s1",
      participation: BranchParticipationKind.Wrote,
      branchCount: 1,
      estimatedCostUsd: 4,
      activitySegments: [seg(T, T + 5000, 2)],
      lifecycleEvents: [writeEvent(2000)],
    };
    const s1b = {
      sessionId: "s1",
      participation: BranchParticipationKind.Wrote,
      branchCount: 1,
      estimatedCostUsd: 4,
      activitySegments: [seg(T + 10_000, T + 20_000, 2)],
      lifecycleEvents: [writeEvent(15_000)],
    };
    const result = projectBranchPhaseAttribution({
      sessions: [s1, s1b],
      pullRequestCycles: [],
    });
    // Both segments should be projected
    expect(result.segments).toHaveLength(2);
  });

  it("merges participation: Wrote wins over Reviewed regardless of order", () => {
    const wrote = {
      sessionId: "s1",
      participation: BranchParticipationKind.Wrote,
      branchCount: 1,
      estimatedCostUsd: 1,
      activitySegments: [seg(T, T + 10_000, 1)],
      lifecycleEvents: [writeEvent(5000)],
    };
    const reviewed = {
      sessionId: "s1",
      participation: BranchParticipationKind.Reviewed,
      branchCount: 1,
      estimatedCostUsd: 1,
      activitySegments: [],
      lifecycleEvents: [],
    };
    // Wrote first, then Reviewed → still Wrote (not filtered by Reviewed guard)
    const result = projectBranchPhaseAttribution({
      sessions: [wrote, reviewed],
      pullRequestCycles: [],
    });
    // Wrote participation means the Reviewed-only guard does not apply;
    // the session IS projected (has a write event → Build).
    expect(result.segments[0].phase).toBe(BranchVisibleLifecyclePhase.Build);
  });

  it("propagates PricingIncomplete for a non-finite cost value", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: Number.POSITIVE_INFINITY,
          activitySegments: [seg(T, T + 10_000, 1)],
          lifecycleEvents: [writeEvent(5000)],
        },
      ],
      pullRequestCycles: [],
    });
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.PricingIncomplete
    );
  });

  it("propagates MalformedEvidence for a negative branchCount", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: -1,
          estimatedCostUsd: 1,
          activitySegments: [seg(T, T + 10_000, 1)],
          lifecycleEvents: [writeEvent(5000)],
        },
      ],
      pullRequestCycles: [],
    });
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.MalformedEvidence
    );
  });

  it("propagates MalformedEvidence for a non-integer branchCount", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1.5,
          estimatedCostUsd: 1,
          activitySegments: [seg(T, T + 10_000, 1)],
          lifecycleEvents: [writeEvent(5000)],
        },
      ],
      pullRequestCycles: [],
    });
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.MalformedEvidence
    );
  });
});

describe("projectBranchPhaseAttribution edge cases — participation and segment filtering", () => {
  it("skips a Reviewed session whose lifecycle events contain no ReviewFeedback", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Reviewed,
          branchCount: 1,
          estimatedCostUsd: 3,
          activitySegments: [seg(T + 20_000, T + 30_000, 3)],
          lifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.BranchWrite,
              observedAt: iso(25_000),
              evidenceId: "w1",
              method: "git_push",
            },
          ],
        },
      ],
      pullRequestCycles: [
        { pullRequestId: "pr-1", openedAt: iso(10_000), terminalAt: null },
      ],
    });
    // Reviewed session without ReviewFeedback is filtered out
    expect(result.segments).toHaveLength(0);
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 0,
    });
  });

  it("drops a session whose activitySegments is undefined (MissingActivitySegments) when cost is non-null", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 5,
          activitySegments: undefined,
          lifecycleEvents: [writeEvent(5000)],
        },
      ],
      pullRequestCycles: [],
    });
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.MissingActivitySegments,
    });
  });

  it("sets LifecycleIncomplete when priced segments exist but no lifecycle events", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 1,
          activitySegments: [seg(T, T + 10_000, 1)],
          lifecycleEvents: [],
        },
      ],
      pullRequestCycles: [],
    });
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.LifecycleIncomplete
    );
  });

  it("marks PricingIncomplete when a null-cost segment has source event IDs", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: null,
          activitySegments: [
            {
              ...segWithId(T, T + 10_000, 0, "src-1"),
              costUsd: null,
              inputTokens: 0,
              outputTokens: 0,
            },
          ],
          lifecycleEvents: [writeEvent(5000)],
        },
      ],
      pullRequestCycles: [],
    });
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.PricingIncomplete
    );
  });

  it("silently drops a null-cost segment that has no spend evidence", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: null,
          activitySegments: [
            {
              phase: "idle",
              startMs: T,
              endMs: T + 10_000,
              costUsd: null,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              confidence: 0.9,
            },
          ],
          lifecycleEvents: [writeEvent(5000)],
        },
      ],
      pullRequestCycles: [],
    });
    // A null-cost segment with no spend evidence is not "missing" pricing —
    // there was nothing to price — so coverage stays Complete and carries no
    // reason at all. Asserted on `completeness` rather than
    // `reason !== PricingIncomplete`, which every non-pricing state (including
    // this one, where `reason` is absent) would satisfy vacuously.
    expect(result.coverage.completeness).toBe(
      BranchPhaseAttributionCompleteness.Complete
    );
    expect(result.segments).toHaveLength(0);
  });
});
