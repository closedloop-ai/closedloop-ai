import {
  type BranchActivitySegment,
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it } from "vitest";
import {
  type BranchPhaseAttributionInput,
  projectBranchPhaseAttribution,
} from "./branch-phase-attribution";

const baseMs = Date.parse("2026-08-01T00:00:00.000Z");

describe("projectBranchPhaseAttribution", () => {
  it("projects every qualifying pre-PR hidden-label segment to Build exactly once", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [segment("plan", 0, 10, 1), segment("idle", 10, 20, 2)],
          events: [
            event(BranchLifecycleBoundaryKind.BranchWrite, 5, "push-1"),
            event(BranchLifecycleBoundaryKind.BranchWrite, 15, "push-2"),
          ],
        }),
        session({
          segments: [segment("plan", 0, 10, 1)],
          events: [event(BranchLifecycleBoundaryKind.BranchWrite, 5, "push-1")],
        }),
      ],
      pullRequestCycles: [],
    });

    expect(result.segments).toHaveLength(2);
    expect(
      result.segments.every(
        (item) => item.phase === BranchVisibleLifecyclePhase.Build
      )
    ).toBe(true);
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 3,
    });
  });

  it("returns complete only when all qualifying priced evidence projects", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [segment("implement", 0, 10, 1)],
          events: [event(BranchLifecycleBoundaryKind.BranchWrite, 5)],
        }),
      ],
      pullRequestCycles: [],
    });

    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 1,
    });
  });

  it("closes visible output to Build Review Rework", () => {
    expect(Object.values(BranchVisibleLifecyclePhase)).toEqual([
      BranchVisibleLifecyclePhase.Build,
      BranchVisibleLifecyclePhase.Review,
      BranchVisibleLifecyclePhase.Rework,
    ]);
  });

  it("keeps qualifying no-PR work in Build and emits no Review", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [segment("other", 0, 10, 1)],
          events: [event(BranchLifecycleBoundaryKind.BranchWrite, 5)],
        }),
      ],
      pullRequestCycles: [],
    });

    expect(result.rollups.map((rollup) => rollup.phase)).toEqual([
      BranchVisibleLifecyclePhase.Build,
    ]);
  });

  it("attributes only successful post-PR review evidence to Review", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [segment("explore", 20, 30, 1)],
          events: [event(BranchLifecycleBoundaryKind.ReviewFeedback, 25)],
        }),
      ],
      pullRequestCycles: [cycle("pr-1", 10, null)],
    });

    expect(result.segments[0].phase).toBe(BranchVisibleLifecyclePhase.Review);
  });

  it("does not create Review from passive or pending evidence", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [segment("review", 20, 30, 1)],
          events: [event(BranchLifecycleBoundaryKind.ReadOnlyReference, 25)],
        }),
      ],
      pullRequestCycles: [cycle("pr-1", 10, null)],
    });

    expect(result.segments).toEqual([]);
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 0,
    });
  });

  it("keeps Review through publication and starts non-overlapping Rework later", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [
            segment("review", 20, 30, 1),
            segment("implement", 30, 40, 2),
          ],
          events: [
            event(BranchLifecycleBoundaryKind.ReviewFeedback, 25),
            event(BranchLifecycleBoundaryKind.BranchWrite, 35),
          ],
        }),
      ],
      pullRequestCycles: [cycle("pr-1", 10, null)],
    });

    expect(result.segments.map((item) => item.phase)).toEqual([
      BranchVisibleLifecyclePhase.Review,
      BranchVisibleLifecyclePhase.Rework,
    ]);
    expect(result.coverage).toMatchObject({ subtotalUsd: 3 });
  });

  it("keeps a same-segment publication and later write in Review", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [segment("validate", 20, 40, 1)],
          events: [
            event(BranchLifecycleBoundaryKind.ReviewFeedback, 25),
            event(BranchLifecycleBoundaryKind.BranchWrite, 35),
          ],
        }),
      ],
      pullRequestCycles: [cycle("pr-1", 10, null)],
    });

    expect(result.segments[0].phase).toBe(BranchVisibleLifecyclePhase.Review);
  });

  it("does not choose one phase for writes that cross a PR-open boundary", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [segment("implement", 0, 20, 1)],
          events: [
            event(BranchLifecycleBoundaryKind.BranchWrite, 5),
            event(BranchLifecycleBoundaryKind.BranchWrite, 15),
          ],
        }),
      ],
      pullRequestCycles: [cycle("pr-1", 10, null)],
    });

    expect(result.segments).toEqual([]);
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.AmbiguousEvidence,
    });
  });

  it("starts post-terminal pushed work in Build and retains post-terminal Review", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [
            segment("implement", 30, 40, 1),
            segment("other", 40, 50, 2),
          ],
          events: [
            event(BranchLifecycleBoundaryKind.BranchWrite, 35),
            event(BranchLifecycleBoundaryKind.ReviewFeedback, 45),
          ],
        }),
      ],
      pullRequestCycles: [cycle("pr-1", 10, 30)],
    });

    expect(result.segments.map((item) => item.phase)).toEqual([
      BranchVisibleLifecyclePhase.Build,
      BranchVisibleLifecyclePhase.Review,
    ]);
  });

  it("classifies sequential PR cycles without cross-cycle relabeling", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [
            segment("implement", 15, 20, 1),
            segment("implement", 35, 40, 2),
            segment("implement", 55, 60, 3),
          ],
          events: [
            event(BranchLifecycleBoundaryKind.BranchWrite, 16),
            event(BranchLifecycleBoundaryKind.BranchWrite, 36),
            event(BranchLifecycleBoundaryKind.BranchWrite, 56),
          ],
        }),
      ],
      pullRequestCycles: [cycle("pr-1", 10, 30), cycle("pr-2", 50, null)],
    });

    expect(result.segments.map((item) => item.phase)).toEqual([
      BranchVisibleLifecyclePhase.Rework,
      BranchVisibleLifecyclePhase.Build,
      BranchVisibleLifecyclePhase.Rework,
    ]);
  });

  it("uses explicit reopen evidence to begin a new cycle", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [
            segment("implement", 35, 40, 1),
            segment("implement", 55, 60, 2),
          ],
          events: [
            event(BranchLifecycleBoundaryKind.BranchWrite, 36),
            event(BranchLifecycleBoundaryKind.BranchWrite, 56),
          ],
        }),
      ],
      pullRequestCycles: [cycle("pr-1", 10, 30), cycle("pr-1", 50, null)],
    });

    expect(result.segments.map((item) => item.phase)).toEqual([
      BranchVisibleLifecyclePhase.Build,
      BranchVisibleLifecyclePhase.Rework,
    ]);
  });

  it("starts folded-reopen attribution at the first later qualifying push", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [segment("implement", 35, 40, 1)],
          events: [event(BranchLifecycleBoundaryKind.BranchWrite, 36)],
        }),
      ],
      pullRequestCycles: [cycle("pr-1", 10, 30)],
      ambiguousWriteAfter: [new Date(baseMs + 30_000).toISOString()],
    });

    expect(result.segments.map((item) => item.phase)).toEqual([
      BranchVisibleLifecyclePhase.Build,
    ]);
  });

  it("uses a later explicit cycle despite an earlier ambiguous boundary", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [segment("implement", 55, 60, 1)],
          events: [event(BranchLifecycleBoundaryKind.BranchWrite, 56)],
        }),
      ],
      pullRequestCycles: [cycle("pr-1", 10, 30), cycle("pr-1", 50, null)],
      ambiguousWriteAfter: [new Date(baseMs + 30_000).toISOString()],
    });

    expect(result.segments[0]?.phase).toBe(BranchVisibleLifecyclePhase.Rework);
  });

  it("starts a folded reopen at the first push not covered by an explicit cycle", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [
            segment("implement", 40, 50, 1),
            segment("implement", 60, 70, 2),
          ],
          events: [
            event(BranchLifecycleBoundaryKind.BranchWrite, 45),
            event(BranchLifecycleBoundaryKind.BranchWrite, 65),
          ],
        }),
      ],
      pullRequestCycles: [cycle("pr-1", 10, 30), cycle("pr-2", 40, 50)],
      ambiguousWriteAfter: [new Date(baseMs + 30_000).toISOString()],
    });

    expect(result.segments.map((item) => item.phase)).toEqual([
      BranchVisibleLifecyclePhase.Rework,
      BranchVisibleLifecyclePhase.Build,
    ]);
  });

  it("uses a qualifying push when its segment also contains a local commit", () => {
    const localCommit = {
      ...event(BranchLifecycleBoundaryKind.BranchWrite, 22),
      method: "git_command",
    };
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [segment("implement", 20, 30, 1)],
          events: [
            localCommit,
            event(BranchLifecycleBoundaryKind.BranchWrite, 25),
          ],
        }),
      ],
      pullRequestCycles: [cycle("pr-1", 10, null)],
    });

    expect(result.segments[0]?.phase).toBe(BranchVisibleLifecyclePhase.Rework);
  });

  it("marks review evidence ambiguous when multiple PR cycles are active", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [segment("review", 20, 30, 1)],
          events: [event(BranchLifecycleBoundaryKind.ReviewFeedback, 25)],
        }),
      ],
      pullRequestCycles: [cycle("pr-1", 10, null), cycle("pr-2", 20, null)],
    });

    expect(result.segments).toEqual([]);
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.AmbiguousEvidence,
    });
  });

  it("degrades ambiguous or incomplete lifecycle evidence without fabrication", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [segment("review", 20, 30, 1)],
          events: [event(BranchLifecycleBoundaryKind.ReviewFeedback, 25)],
        }),
      ],
      pullRequestCycles: [],
    });

    expect(result.segments).toEqual([]);
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.LifecycleIncomplete,
    });
  });

  it("returns a typed partial subtotal with deterministic reason precedence", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [segment("other", 0, 10, 2)],
          events: [event(BranchLifecycleBoundaryKind.BranchWrite, 5)],
        }),
      ],
      pullRequestCycles: [],
      coverageReasons: [
        BranchPhaseAttributionCompletenessReason.MissingActivitySegments,
        BranchPhaseAttributionCompletenessReason.CoverageCapped,
      ],
    });

    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Partial,
      reason: BranchPhaseAttributionCompletenessReason.CoverageCapped,
      subtotalUsd: 2,
    });
  });

  it("returns unavailable without a fabricated subtotal", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({ segments: undefined, events: [], estimatedCostUsd: 4 }),
      ],
      pullRequestCycles: [],
    });

    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.MissingActivitySegments,
    });
  });

  it("does not call known zero complete when its activity tiling is missing", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [session({ segments: [], events: [], estimatedCostUsd: 0 })],
      pullRequestCycles: [],
    });

    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.MissingActivitySegments,
    });
  });

  it("reports unavailable pricing instead of dropping an unpriced activity segment", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [{ ...segment("implement", 0, 10, 1), costUsd: null }],
          events: [event(BranchLifecycleBoundaryKind.BranchWrite, 5)],
        }),
      ],
      pullRequestCycles: [],
    });

    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.PricingIncomplete,
    });
  });

  it("treats an idle span with no spend events as a complete zero, not unpriced", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          estimatedCostUsd: 0,
          segments: [segment("idle", 0, 10, null, 0, 0, 0, 0)],
          events: [event(BranchLifecycleBoundaryKind.BranchWrite, 5)],
        }),
      ],
      pullRequestCycles: [],
    });

    expect(result.segments).toEqual([]);
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 0,
    });
  });

  it("does not allocate through an invalid or conflicting branch divisor", () => {
    const base = session({
      branchCount: 2,
      segments: [segment("implement", 0, 10, 1)],
      events: [event(BranchLifecycleBoundaryKind.BranchWrite, 5)],
    });
    const result = projectBranchPhaseAttribution({
      sessions: [base, { ...base, branchCount: 3 }],
      pullRequestCycles: [],
    });

    expect(result.segments).toEqual([]);
    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.AmbiguousEvidence,
    });
  });

  it("preserves a defensible zero subtotal as partial rather than unavailable", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [segment("implement", 0, 10, 0)],
          events: [event(BranchLifecycleBoundaryKind.BranchWrite, 5)],
        }),
      ],
      pullRequestCycles: [],
      coverageReasons: [
        BranchPhaseAttributionCompletenessReason.CoverageCapped,
      ],
    });

    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Partial,
      reason: BranchPhaseAttributionCompletenessReason.CoverageCapped,
      subtotalUsd: 0,
    });
  });

  it("deduplicates repeated Session links and stable segments exactly once", () => {
    const duplicate = session({
      segments: [segment("other", 0, 10, 1)],
      events: [event(BranchLifecycleBoundaryKind.BranchWrite, 5)],
    });
    const result = projectBranchPhaseAttribution({
      sessions: [duplicate, duplicate],
      pullRequestCycles: [],
    });

    expect(result.segments).toHaveLength(1);
    expect(result.coverage).toMatchObject({ subtotalUsd: 1 });
  });

  it("applies branch divisor once to cost and preserves raw tokens", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          branchCount: 3,
          segments: [
            segment("implement", 0, 10, 1, 10, 5, 3, 1),
            segment("implement", 10, 20, 2, 20, 10, 6, 2),
          ],
          events: [
            event(BranchLifecycleBoundaryKind.BranchWrite, 5),
            event(BranchLifecycleBoundaryKind.BranchWrite, 15),
          ],
        }),
      ],
      pullRequestCycles: [],
    });

    expect(result.coverage).toMatchObject({ subtotalUsd: 1 });
    expect(result.rollups[0]).toMatchObject({
      inputTokens: 30,
      outputTokens: 15,
      cacheReadTokens: 9,
      cacheWriteTokens: 3,
    });
  });

  it("unions same-phase wall clock while summing cost and tokens", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          id: "session-1",
          segments: [segment("implement", 0, 20, 1)],
          events: [event(BranchLifecycleBoundaryKind.BranchWrite, 5)],
        }),
        session({
          id: "session-2",
          segments: [segment("validate", 10, 30, 2)],
          events: [event(BranchLifecycleBoundaryKind.BranchWrite, 15)],
        }),
      ],
      pullRequestCycles: [],
    });

    expect(result.rollups[0]).toMatchObject({
      durationMs: 30_000,
      estimatedCostUsd: 3,
      sessionCount: 2,
    });
  });

  it("rejects malformed numeric and timestamp evidence conservatively", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          segments: [{ ...segment("other", 0, 10, 1), startMs: Number.NaN }],
          events: [event(BranchLifecycleBoundaryKind.BranchWrite, 5)],
        }),
      ],
      pullRequestCycles: [],
    });

    expect(result.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.MalformedEvidence,
    });
  });

  it("includes reviewed-only Session spend only for a successful Review outcome", () => {
    const result = projectBranchPhaseAttribution({
      sessions: [
        session({
          participation: BranchParticipationKind.Reviewed,
          segments: [segment("review", 20, 30, 1)],
          events: [event(BranchLifecycleBoundaryKind.ReviewFeedback, 25)],
        }),
      ],
      pullRequestCycles: [cycle("pr-1", 10, null)],
    });

    expect(result.segments.map((item) => item.phase)).toEqual([
      BranchVisibleLifecyclePhase.Review,
    ]);
  });
});

type SessionOptions = {
  id?: string;
  participation?: BranchParticipationKind;
  branchCount?: number;
  estimatedCostUsd?: number | null;
  segments?: ReturnType<typeof segment>[];
  events?: ReturnType<typeof event>[];
};

function session(
  options: SessionOptions
): BranchPhaseAttributionInput["sessions"][number] {
  return {
    sessionId: options.id ?? "session-1",
    participation: options.participation ?? BranchParticipationKind.Wrote,
    branchCount: options.branchCount ?? 1,
    estimatedCostUsd: options.estimatedCostUsd ?? 3,
    activitySegments: options.segments,
    lifecycleEvents: options.events,
  };
}

function segment(
  phase: string,
  startSecond: number,
  endSecond: number,
  costUsd: number | null,
  inputTokens = 10,
  outputTokens = 5,
  cacheReadTokens = 2,
  cacheWriteTokens = 1
): BranchActivitySegment {
  return {
    phase,
    startMs: baseMs + startSecond * 1000,
    endMs: baseMs + endSecond * 1000,
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    confidence: 0.9,
  };
}

function event(
  kind: BranchLifecycleBoundaryKind,
  second: number,
  evidenceId = `${kind}-${second}`
) {
  return {
    kind,
    observedAt: new Date(baseMs + second * 1000).toISOString(),
    evidenceId,
    ...(kind === BranchLifecycleBoundaryKind.BranchWrite
      ? { method: "git_push" }
      : {}),
  };
}

function cycle(
  pullRequestId: string,
  openedSecond: number,
  terminalSecond: number | null
) {
  return {
    pullRequestId,
    openedAt: new Date(baseMs + openedSecond * 1000).toISOString(),
    terminalAt:
      terminalSecond === null
        ? null
        : new Date(baseMs + terminalSecond * 1000).toISOString(),
  };
}
