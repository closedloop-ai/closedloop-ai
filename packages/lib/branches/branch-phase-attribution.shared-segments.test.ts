import {
  type BranchActivitySegment,
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import { BranchPhaseAttributionCompletenessReason } from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it } from "vitest";
import {
  type BranchPhaseAttributionInput,
  projectBranchPhaseAttribution,
} from "./branch-phase-attribution";

/**
 * ISS-11589: one Session is attributed once per Branch it touches, and the
 * cloud read hands every Branch the same segment array for that Session. The
 * per-segment validation and de-duplication depends only on those segments, so
 * it is done once per array. Results and completeness reasons must not change.
 */

const baseMs = Date.parse("2026-08-01T00:00:00.000Z");

describe("projectBranchPhaseAttribution with a segment array shared across calls", () => {
  it("projects the same result as unshared copies", () => {
    const shared = [segment(0, 10, 1), segment(10, 20, 2)];

    const first = projectBranchPhaseAttribution(input([shared]));
    const second = projectBranchPhaseAttribution(input([shared]));
    const copied = projectBranchPhaseAttribution(
      input([shared.map((entry) => ({ ...entry }))])
    );

    expect(second).toEqual(first);
    expect(first).toEqual(copied);
    expect(first.segments).toHaveLength(2);
  });

  it("repeats a conflict's completeness reason on every call, not just the first", () => {
    const shared = [
      segment(0, 10, 1, ["event-1"]),
      segment(0, 10, 2, ["event-1"]),
    ];

    const reasonsOf = () =>
      projectBranchPhaseAttribution(input([shared])).coverage;

    expect(reasonsOf()).toEqual(reasonsOf());
    const calls = [
      projectBranchPhaseAttribution(input([shared])),
      projectBranchPhaseAttribution(input([shared])),
    ];
    for (const result of calls) {
      expect(result.coverage.completeness).not.toBe("complete");
      expect(result.segments).toHaveLength(0);
    }
  });

  it("keeps a conflict found in one array out of an unrelated array", () => {
    const conflicting = [
      segment(0, 10, 1, ["event-1"]),
      segment(0, 10, 2, ["event-1"]),
    ];
    const clean = [segment(20, 30, 3)];
    projectBranchPhaseAttribution(input([conflicting]));

    const result = projectBranchPhaseAttribution(input([clean]));

    expect(result.coverage.completeness).toBe("complete");
    expect(result.segments).toHaveLength(1);
  });

  it("flags a malformed segment on each call that uses its array", () => {
    const shared = [segment(10, 0, 1)];

    const results = [1, 2].map(() =>
      projectBranchPhaseAttribution(input([shared]))
    );

    for (const result of results) {
      expect(result.coverage.completeness).not.toBe("complete");
    }
    expect(BranchPhaseAttributionCompletenessReason.MalformedEvidence).toBe(
      "malformed_evidence"
    );
  });

  it("counts one occurrence when the same array arrives twice for a Session", () => {
    const shared = [segment(0, 10, 4)];

    const once = projectBranchPhaseAttribution(input([shared]));
    const twice = projectBranchPhaseAttribution({
      sessions: [sessionInput(shared), sessionInput(shared)],
      pullRequestCycles: [],
    });

    expect(twice.segments).toEqual(once.segments);
    expect(twice.coverage).toEqual(once.coverage);
  });

  it("still merges a second, different array for the same Session", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        sessionInput([segment(0, 10, 1)]),
        sessionInput([segment(10, 20, 2)]),
      ],
      pullRequestCycles: [],
    });

    expect(result.segments).toHaveLength(2);
  });

  it("does the per-segment work once per array across calls", () => {
    let reads = 0;
    const counted: BranchActivitySegment = {
      ...segment(0, 10, 1),
      get sourceEventIds() {
        reads += 1;
        return ["event-a"];
      },
    };
    const shared = [counted];

    projectBranchPhaseAttribution(input([shared]));
    const afterFirst = reads;
    projectBranchPhaseAttribution(input([shared]));
    projectBranchPhaseAttribution(input([shared]));

    expect(afterFirst).toBeGreaterThan(0);
    expect(reads).toBe(afterFirst);
  });
});

function input(
  segmentArrays: BranchActivitySegment[][]
): BranchPhaseAttributionInput {
  return {
    sessions: segmentArrays.map((segments) => sessionInput(segments)),
    pullRequestCycles: [],
  };
}

function sessionInput(
  segments: BranchActivitySegment[]
): BranchPhaseAttributionInput["sessions"][number] {
  return {
    sessionId: "session-1",
    participation: BranchParticipationKind.Wrote,
    branchCount: 1,
    estimatedCostUsd: 3,
    activitySegments: segments,
    lifecycleEvents: [5, 15, 25].map((second) => ({
      kind: BranchLifecycleBoundaryKind.BranchWrite,
      observedAt: new Date(baseMs + second * 1000).toISOString(),
      evidenceId: `push-${second}`,
      method: "git_push",
    })),
  };
}

function segment(
  startSecond: number,
  endSecond: number,
  costUsd: number,
  sourceEventIds?: string[]
): BranchActivitySegment {
  return {
    phase: "implement",
    startMs: baseMs + startSecond * 1000,
    endMs: baseMs + endSecond * 1000,
    costUsd,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    confidence: 0.9,
    ...(sourceEventIds ? { sourceEventIds } : {}),
  };
}
