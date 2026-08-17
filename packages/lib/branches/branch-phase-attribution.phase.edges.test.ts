/**
 * Phase-classification, materializeReopenCycles, distinctSegments, coverage, and
 * rollup edge cases for projectBranchPhaseAttribution. Extracted from
 * branch-phase-attribution.edges.test.ts to keep each file under 1,000 lines.
 */
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

const T = 1_700_000_000_000;

function iso(offsetMs: number): string {
  return new Date(T + offsetMs).toISOString();
}

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

describe("projectBranchPhaseAttribution edge cases — phase classification", () => {
  it("classifies a segment with an UnknownEvidence event as AmbiguousEvidence", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 2,
          activitySegments: [seg(T, T + 10_000, 2)],
          lifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.UnknownEvidence,
              observedAt: iso(5000),
              evidenceId: "unk-1",
            },
          ],
        },
      ],
      pullRequestCycles: [],
    });
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.AmbiguousEvidence
    );
    expect(result.segments).toHaveLength(0);
  });

  it("classifies a segment with a PrRaised event as Build", () => {
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
              kind: BranchLifecycleBoundaryKind.PrRaised,
              observedAt: iso(5000),
              evidenceId: "pr-raised",
            },
          ],
        },
      ],
      pullRequestCycles: [],
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].phase).toBe(BranchVisibleLifecyclePhase.Build);
  });

  it("classifies a BranchWrite at the exact cycle openedAt as Build, not Rework", () => {
    const cycleOpenMs = 10_000;
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 1,
          activitySegments: [seg(T + 5000, T + 15_000, 1)],
          lifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.BranchWrite,
              observedAt: iso(cycleOpenMs),
              evidenceId: "open-push",
              method: "git_push",
            },
          ],
        },
      ],
      pullRequestCycles: [
        { pullRequestId: "pr-1", openedAt: iso(cycleOpenMs), terminalAt: null },
      ],
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].phase).toBe(BranchVisibleLifecyclePhase.Build);
  });

  it("marks AmbiguousEvidence when write events map to different active cycles", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 1,
          activitySegments: [seg(T + 5000, T + 35_000, 1)],
          lifecycleEvents: [writeEvent(15_000), writeEvent(25_000)],
        },
      ],
      pullRequestCycles: [
        {
          pullRequestId: "pr-1",
          openedAt: iso(10_000),
          terminalAt: iso(20_000),
        },
        {
          pullRequestId: "pr-2",
          openedAt: iso(20_000),
          terminalAt: iso(30_000),
        },
      ],
    });
    expect(result.segments).toHaveLength(0);
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.AmbiguousEvidence
    );
  });

  it("marks AmbiguousEvidence when a write event falls under two overlapping cycles", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 1,
          activitySegments: [seg(T + 20_000, T + 40_000, 1)],
          lifecycleEvents: [writeEvent(30_000)],
        },
      ],
      pullRequestCycles: [
        { pullRequestId: "pr-1", openedAt: iso(10_000), terminalAt: null },
        { pullRequestId: "pr-2", openedAt: iso(20_000), terminalAt: null },
      ],
    });
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.AmbiguousEvidence
    );
    expect(result.segments).toHaveLength(0);
  });

  it("marks LifecycleIncomplete when a non-push write after an ambiguous boundary has no cycle", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 1,
          activitySegments: [seg(T + 30_000, T + 40_000, 1)],
          lifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.BranchWrite,
              observedAt: iso(35_000),
              evidenceId: "local-commit",
              method: "git_command",
            },
          ],
        },
      ],
      pullRequestCycles: [
        {
          pullRequestId: "pr-1",
          openedAt: iso(0),
          terminalAt: iso(20_000),
        },
      ],
      ambiguousWriteAfter: [iso(20_000)],
    });
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.LifecycleIncomplete
    );
  });

  it("marks LifecycleIncomplete when two review events span prior cycles with same openedAtMs", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Reviewed,
          branchCount: 1,
          estimatedCostUsd: 1,
          activitySegments: [seg(T + 60_000, T + 120_000, 1)],
          lifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.ReviewFeedback,
              observedAt: iso(90_000),
              evidenceId: "review-1",
            },
          ],
        },
      ],
      pullRequestCycles: [
        {
          pullRequestId: "pr-1",
          openedAt: iso(0),
          terminalAt: iso(30_000),
        },
        {
          pullRequestId: "pr-2",
          openedAt: iso(0),
          terminalAt: iso(30_000),
        },
      ],
    });
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.LifecycleIncomplete
    );
    expect(result.segments).toHaveLength(0);
  });
});

describe("projectBranchPhaseAttribution edge cases — materializeReopenCycles", () => {
  it("produces no synthetic cycle when all pushes precede the ambiguous boundary", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 1,
          activitySegments: [seg(T, T + 10_000, 1)],
          lifecycleEvents: [writeEvent(5000)],
        },
      ],
      pullRequestCycles: [
        { pullRequestId: "pr-1", openedAt: iso(0), terminalAt: iso(20_000) },
      ],
      ambiguousWriteAfter: [iso(20_000)],
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].phase).toBe(BranchVisibleLifecyclePhase.Rework);
  });
});

describe("projectBranchPhaseAttribution edge cases — distinctSegments and cost allocation", () => {
  it("deduplicates segments by sourceEventIds key, not legacy interval key", () => {
    const sharedSource = "src-shared";
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 2,
          activitySegments: [
            segWithId(T, T + 10_000, 1, sharedSource),
            segWithId(T, T + 10_000, 1, sharedSource),
          ],
          lifecycleEvents: [writeEvent(5000)],
        },
      ],
      pullRequestCycles: [],
    });
    expect(result.segments).toHaveLength(1);
    expect(result.coverage.completeness).toBe(
      BranchPhaseAttributionCompleteness.Complete
    );
  });

  it("marks AmbiguousEvidence and drops conflicting same-sourceEventId segments", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 2,
          activitySegments: [
            {
              phase: "build",
              startMs: T,
              endMs: T + 10_000,
              costUsd: 1,
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              confidence: 0.9,
              sourceEventIds: ["src-conflict"],
            },
            {
              phase: "review",
              startMs: T,
              endMs: T + 10_000,
              costUsd: 1,
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              confidence: 0.9,
              sourceEventIds: ["src-conflict"],
            },
          ],
          lifecycleEvents: [writeEvent(5000)],
        },
      ],
      pullRequestCycles: [],
    });
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.AmbiguousEvidence
    );
  });

  it("skips allocating cost for a session whose merged branchCount is null", () => {
    const base = {
      sessionId: "s1",
      participation: BranchParticipationKind.Wrote,
      branchCount: 2,
      estimatedCostUsd: 1,
      activitySegments: [seg(T, T + 10_000, 1)],
      lifecycleEvents: [writeEvent(5000)],
    };
    const conflict = {
      ...base,
      branchCount: 3,
      activitySegments: [],
      lifecycleEvents: [],
    };
    const result = projectBranchPhaseAttribution({
      sessions: [base, conflict],
      pullRequestCycles: [],
    });
    expect(result.segments).toHaveLength(0);
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.AmbiguousEvidence
    );
  });
});

describe("projectBranchPhaseAttribution edge cases — coverage and sorting", () => {
  it("compareProjectedSegments uses endMs as tiebreaker when startMs is equal", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 1,
          activitySegments: [seg(T, T + 20_000, 1)],
          lifecycleEvents: [writeEvent(5000)],
        },
        {
          sessionId: "s2",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 2,
          activitySegments: [seg(T, T + 10_000, 2)],
          lifecycleEvents: [writeEvent(5000)],
        },
      ],
      pullRequestCycles: [],
    });
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].endMs).toBe(T + 10_000);
    expect(result.segments[1].endMs).toBe(T + 20_000);
  });

  it("produces Partial coverage when reasons exist and segments are projected", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 2,
          activitySegments: [seg(T, T + 10_000, 2)],
          lifecycleEvents: [writeEvent(5000)],
        },
      ],
      pullRequestCycles: [],
      coverageReasons: [
        BranchPhaseAttributionCompletenessReason.CoverageCapped,
      ],
    });
    expect(result.coverage.completeness).toBe(
      BranchPhaseAttributionCompleteness.Partial
    );
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.CoverageCapped
    );
    expect(result.segments).toHaveLength(1);
  });

  it("produces Unavailable when reasons exist but no segments project", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [],
      pullRequestCycles: [],
      coverageReasons: [
        BranchPhaseAttributionCompletenessReason.LifecycleIncomplete,
      ],
    });
    expect(result.coverage.completeness).toBe(
      BranchPhaseAttributionCompleteness.Unavailable
    );
    expect(expectIncompleteCoverage(result.coverage).reason).toBe(
      BranchPhaseAttributionCompletenessReason.LifecycleIncomplete
    );
  });

  it("carries evidenceIds from contained lifecycle events onto the projected segment", () => {
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
              observedAt: iso(5000),
              evidenceId: "ev-with-id",
              method: "git_push",
            },
          ],
        },
      ],
      pullRequestCycles: [],
    });
    expect(result.segments[0].evidenceIds).toContain("ev-with-id");
  });

  it("carries costEvents from segments that include sourceEventIds", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 1,
          activitySegments: [
            {
              phase: "build",
              startMs: T,
              endMs: T + 10_000,
              costUsd: 1,
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              confidence: 0.9,
              sourceEventIds: ["cost-src-1"],
              costEvents: [
                {
                  sourceEventId: "cost-src-1",
                  occurredAtMs: T + 3000,
                  costUsd: 1,
                },
              ],
            },
          ],
          lifecycleEvents: [writeEvent(5000)],
        },
      ],
      pullRequestCycles: [],
    });
    expect(result.segments[0].costEvents).toBeDefined();
    expect(result.segments[0].costEvents).toHaveLength(1);
  });

  it("unionDurationMs handles overlapping Build segments across sessions in the rollup", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 1,
          activitySegments: [seg(T, T + 10_000, 1)],
          lifecycleEvents: [writeEvent(5000)],
        },
        {
          sessionId: "s2",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 2,
          activitySegments: [seg(T + 5000, T + 20_000, 2)],
          lifecycleEvents: [writeEvent(10_000)],
        },
      ],
      pullRequestCycles: [],
    });
    // Union of [T..T+10k] and [T+5k..T+20k] = [T..T+20k] = 20_000ms
    const buildRollup = result.rollups.find(
      (r) => r.phase === BranchVisibleLifecyclePhase.Build
    );
    expect(buildRollup).toBeDefined();
    expect(buildRollup?.durationMs).toBe(20_000);
  });

  it("returns a rollup durationMs that reflects the single segment span", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        {
          sessionId: "s1",
          participation: BranchParticipationKind.Wrote,
          branchCount: 1,
          estimatedCostUsd: 0,
          activitySegments: [seg(T, T + 5000, 0)],
          lifecycleEvents: [writeEvent(2000)],
        },
      ],
      pullRequestCycles: [],
      coverageReasons: [
        BranchPhaseAttributionCompletenessReason.CoverageCapped,
      ],
    });
    const buildRollup = result.rollups.find(
      (r) => r.phase === BranchVisibleLifecyclePhase.Build
    );
    expect(buildRollup?.durationMs).toBe(5000);
  });
});
