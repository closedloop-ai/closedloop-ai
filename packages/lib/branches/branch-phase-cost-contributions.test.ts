import {
  BranchPhaseAttributionCompleteness,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it } from "vitest";
import {
  branchMetricCostContributions,
  hasCompleteBranchMetricEventCost,
} from "./branch-phase-cost-contributions";

describe("Branch metric event-cost completeness", () => {
  it("rejects a segment subtotal that exceeds its identified event set", () => {
    expect(hasCompleteBranchMetricEventCost(attribution(15, 10))).toBe(false);
  });

  it("accepts an identified event set that exactly reconciles after division", () => {
    expect(hasCompleteBranchMetricEventCost(attribution(15, 30))).toBe(true);
  });

  it("rejects a session whose divisor is missing or not a positive integer", () => {
    for (const qualifyingBranchCount of [undefined, 0, -1, 1.5]) {
      expect(
        hasCompleteBranchMetricEventCost(
          withSegments([segment({ qualifyingBranchCount })])
        ),
        String(qualifyingBranchCount)
      ).toBe(false);
    }
  });

  it("rejects a session whose segments disagree on the divisor", () => {
    expect(
      hasCompleteBranchMetricEventCost(
        withSegments([
          segment({ estimatedCostUsd: 5 }),
          segment({
            sequence: 1,
            estimatedCostUsd: 0,
            qualifyingBranchCount: 3,
            costEvents: [],
          }),
        ])
      )
    ).toBe(false);
  });

  it("counts an event shared by two segments of one session once", () => {
    expect(
      hasCompleteBranchMetricEventCost(
        withSegments([
          segment({ estimatedCostUsd: 3 }),
          segment({ sequence: 1, estimatedCostUsd: 2 }),
        ])
      )
    ).toBe(true);
  });

  it("rejects a shared event id that reports a different time or cost", () => {
    const conflicts = [
      { sourceEventId: "event-1", occurredAtMs: 2, costUsd: 10 },
      { sourceEventId: "event-1", occurredAtMs: 1, costUsd: 11 },
    ];
    for (const conflict of conflicts) {
      expect(
        hasCompleteBranchMetricEventCost(
          withSegments([
            segment({ estimatedCostUsd: 3, costEvents: [conflict] }),
            segment({ sequence: 1, estimatedCostUsd: 2 }),
          ])
        )
      ).toBe(false);
    }
  });

  it("treats a segment with no cost events as zero identified cost", () => {
    expect(
      hasCompleteBranchMetricEventCost(
        withSegments([segment({ estimatedCostUsd: 0, costEvents: undefined })])
      )
    ).toBe(true);
    expect(
      hasCompleteBranchMetricEventCost(
        withSegments([segment({ estimatedCostUsd: 1, costEvents: undefined })])
      )
    ).toBe(false);
  });
});

describe("branchMetricCostContributions", () => {
  it("flattens every segment event into one contribution per branch", () => {
    const contributions = branchMetricCostContributions(
      new Map([
        [
          "branch-1",
          withSegments([
            segment({}),
            segment({
              sessionId: "session-2",
              qualifyingBranchCount: undefined,
              costEvents: undefined,
            }),
          ]),
        ],
        [
          "branch-2",
          withSegments([
            segment({
              sessionId: "session-3",
              qualifyingBranchCount: undefined,
              costEvents: [
                { sourceEventId: "event-3", occurredAtMs: 0, costUsd: 1.25 },
              ],
            }),
          ]),
        ],
      ])
    );

    expect(contributions).toEqual([
      {
        sourceEventId: "event-1",
        branchId: "branch-1",
        sessionId: "session-1",
        occurredAt: "1970-01-01T00:00:00.001Z",
        costUsd: 10,
        qualifyingBranchCount: 2,
      },
      {
        sourceEventId: "event-3",
        branchId: "branch-2",
        sessionId: "session-3",
        occurredAt: "1970-01-01T00:00:00.000Z",
        costUsd: 1.25,
        qualifyingBranchCount: null,
      },
    ]);
  });
});

function attribution(
  allocatedCostUsd: number,
  identifiedCostUsd: number
): BranchPhaseAttributionResult {
  return {
    segments: [
      {
        sessionId: "session-1",
        sequence: 0,
        phase: BranchVisibleLifecyclePhase.Build,
        startMs: 1,
        endMs: 2,
        estimatedCostUsd: allocatedCostUsd,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        evidenceIds: [],
        qualifyingBranchCount: 2,
        costEvents: [
          {
            sourceEventId: "identified-event",
            occurredAtMs: 1,
            costUsd: identifiedCostUsd,
          },
        ],
      },
    ],
    rollups: [],
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: allocatedCostUsd,
    },
  };
}

type Segment = BranchPhaseAttributionResult["segments"][number];

function segment(overrides: Partial<Segment>): Segment {
  return {
    sessionId: "session-1",
    sequence: 0,
    phase: BranchVisibleLifecyclePhase.Build,
    startMs: 1,
    endMs: 2,
    estimatedCostUsd: 5,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    evidenceIds: [],
    qualifyingBranchCount: 2,
    costEvents: [{ sourceEventId: "event-1", occurredAtMs: 1, costUsd: 10 }],
    ...overrides,
  };
}

function withSegments(segments: Segment[]): BranchPhaseAttributionResult {
  return {
    segments,
    rollups: [],
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 0,
    },
  };
}
