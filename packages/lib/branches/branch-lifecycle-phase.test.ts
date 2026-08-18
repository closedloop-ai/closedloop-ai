import {
  BranchLifecycleBoundaryKind,
  BranchLifecyclePhase,
} from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import {
  type BranchLifecyclePhaseEvent,
  deriveBranchLifecyclePhaseSegments,
  normalizeBranchLifecyclePhaseSegments,
} from "./branch-lifecycle-phase";

describe("deriveBranchLifecyclePhaseSegments", () => {
  it("returns no segments for legacy sessions with no lifecycle evidence", () => {
    expect(deriveBranchLifecyclePhaseSegments({ events: [] })).toEqual([]);
    expect(
      deriveBranchLifecyclePhaseSegments({
        sessionStartedAt: "2026-07-22T12:00:00.000Z",
        sessionEndedAt: "2026-07-22T12:30:00.000Z",
        events: [],
      })
    ).toEqual([]);
    expect(normalizeBranchLifecyclePhaseSegments(undefined)).toEqual([]);
  });

  it("keeps pre-PR self-review and branch fixes in Build", () => {
    const segments = deriveBranchLifecyclePhaseSegments({
      sessionStartedAt: "2026-07-22T12:00:00.000Z",
      sessionEndedAt: "2026-07-22T12:30:00.000Z",
      events: [
        event(
          BranchLifecycleBoundaryKind.ReviewFeedback,
          "2026-07-22T12:05:00.000Z",
          "self-review"
        ),
        event(
          BranchLifecycleBoundaryKind.BranchWrite,
          "2026-07-22T12:10:00.000Z",
          "fix"
        ),
      ],
    });

    expect(segments).toMatchObject([
      {
        sequence: 0,
        phase: BranchLifecyclePhase.Build,
        startedAt: "2026-07-22T12:00:00.000Z",
        endedAt: "2026-07-22T12:30:00.000Z",
        evidenceIds: ["self-review", "fix"],
      },
    ]);
  });

  it("omits evidenceIds when a segment has no evidence", () => {
    const segments = deriveBranchLifecyclePhaseSegments({
      events: [
        event(
          BranchLifecycleBoundaryKind.SessionStart,
          "2026-07-22T12:00:00.000Z",
          ""
        ),
        event(
          BranchLifecycleBoundaryKind.SessionEnd,
          "2026-07-22T12:30:00.000Z",
          ""
        ),
      ],
    });

    expect(segments).toMatchObject([
      {
        sequence: 0,
        phase: BranchLifecyclePhase.Build,
        startedAt: "2026-07-22T12:00:00.000Z",
        endedAt: "2026-07-22T12:30:00.000Z",
      },
    ]);
    expect(segments[0]).not.toHaveProperty("evidenceIds");
  });

  it("uses PR-raised as the Build to post-PR boundary", () => {
    const segments = deriveBranchLifecyclePhaseSegments({
      sessionStartedAt: "2026-07-22T12:00:00.000Z",
      sessionEndedAt: "2026-07-22T12:40:00.000Z",
      events: [
        event(
          BranchLifecycleBoundaryKind.BranchWrite,
          "2026-07-22T12:03:00.000Z",
          "build-write"
        ),
        event(
          BranchLifecycleBoundaryKind.PrRaised,
          "2026-07-22T12:10:00.000Z",
          "pr-open"
        ),
        event(
          BranchLifecycleBoundaryKind.ReviewFeedback,
          "2026-07-22T12:20:00.000Z",
          "review-feedback"
        ),
        event(
          BranchLifecycleBoundaryKind.BranchWrite,
          "2026-07-22T12:30:00.000Z",
          "post-pr-fix"
        ),
      ],
    });

    expect(segments).toMatchObject([
      {
        sequence: 0,
        phase: BranchLifecyclePhase.Build,
        startedAt: "2026-07-22T12:00:00.000Z",
        endedAt: "2026-07-22T12:10:00.000Z",
        endBoundary: { kind: BranchLifecycleBoundaryKind.PrRaised },
        evidenceIds: ["build-write", "pr-open"],
      },
      {
        sequence: 1,
        phase: BranchLifecyclePhase.Review,
        startedAt: "2026-07-22T12:20:00.000Z",
        endedAt: "2026-07-22T12:30:00.000Z",
        evidenceIds: ["review-feedback"],
      },
      {
        sequence: 2,
        phase: BranchLifecyclePhase.Rework,
        startedAt: "2026-07-22T12:30:00.000Z",
        endedAt: "2026-07-22T12:40:00.000Z",
        evidenceIds: ["post-pr-fix"],
      },
    ]);
  });

  it("excludes post-PR read-only references from Review and Rework", () => {
    const segments = deriveBranchLifecyclePhaseSegments({
      sessionStartedAt: "2026-07-22T12:00:00.000Z",
      events: [
        event(
          BranchLifecycleBoundaryKind.PrRaised,
          "2026-07-22T12:10:00.000Z",
          "pr-open"
        ),
        event(
          BranchLifecycleBoundaryKind.ReadOnlyReference,
          "2026-07-22T12:20:00.000Z",
          "read-only-pr"
        ),
      ],
    });

    expect(segments.at(-1)).toMatchObject({
      phase: BranchLifecyclePhase.Unknown,
      evidenceIds: ["read-only-pr"],
    });
  });

  it("excludes pre-PR read-only references from Build attribution", () => {
    const segments = deriveBranchLifecyclePhaseSegments({
      sessionStartedAt: "2026-07-22T12:00:00.000Z",
      events: [
        event(
          BranchLifecycleBoundaryKind.ReadOnlyReference,
          "2026-07-22T12:05:00.000Z",
          "read-only-branch"
        ),
      ],
    });

    expect(segments).toMatchObject([
      {
        sequence: 0,
        phase: BranchLifecyclePhase.Unknown,
        evidenceIds: ["read-only-branch"],
      },
    ]);
  });

  it("records Build when PR-raised follows pre-PR Unknown evidence", () => {
    const segments = deriveBranchLifecyclePhaseSegments({
      sessionStartedAt: "2026-07-22T12:00:00.000Z",
      events: [
        event(
          BranchLifecycleBoundaryKind.ReadOnlyReference,
          "2026-07-22T12:05:00.000Z",
          "read-only-branch"
        ),
        event(
          BranchLifecycleBoundaryKind.PrRaised,
          "2026-07-22T12:10:00.000Z",
          "pr-open"
        ),
      ],
    });

    expect(segments).toMatchObject([
      {
        sequence: 0,
        phase: BranchLifecyclePhase.Unknown,
        endedAt: "2026-07-22T12:10:00.000Z",
        evidenceIds: ["read-only-branch"],
      },
      {
        sequence: 1,
        phase: BranchLifecyclePhase.Build,
        startedAt: "2026-07-22T12:10:00.000Z",
        endedAt: "2026-07-22T12:10:00.000Z",
        startBoundary: { kind: BranchLifecycleBoundaryKind.PrRaised },
        endBoundary: { kind: BranchLifecycleBoundaryKind.PrRaised },
        evidenceIds: ["pr-open"],
      },
    ]);
  });

  it("falls back to Unknown for unrecognized boundary kinds", () => {
    const segments = deriveBranchLifecyclePhaseSegments({
      sessionStartedAt: "2026-07-22T12:00:00.000Z",
      events: [
        event("future_boundary", "2026-07-22T12:05:00.000Z", "future-evidence"),
      ],
    });

    expect(segments).toMatchObject([
      {
        sequence: 0,
        phase: BranchLifecyclePhase.Unknown,
        startBoundary: { kind: BranchLifecycleBoundaryKind.UnknownEvidence },
        evidenceIds: ["future-evidence"],
      },
    ]);
  });

  it("ignores duplicate PR-raised boundaries after Build is closed", () => {
    const segments = deriveBranchLifecyclePhaseSegments({
      sessionStartedAt: "2026-07-22T12:00:00.000Z",
      events: [
        event(
          BranchLifecycleBoundaryKind.PrRaised,
          "2026-07-22T12:10:00.000Z",
          "pr-open-1"
        ),
        event(
          BranchLifecycleBoundaryKind.PrRaised,
          "2026-07-22T12:11:00.000Z",
          "pr-open-2"
        ),
        event(
          BranchLifecycleBoundaryKind.BranchWrite,
          "2026-07-22T12:20:00.000Z",
          "post-pr-fix"
        ),
      ],
    });

    expect(segments.map((segment) => segment.phase)).toEqual([
      BranchLifecyclePhase.Build,
      BranchLifecyclePhase.Rework,
    ]);
    expect(segments[0]?.endBoundary).toMatchObject({
      kind: BranchLifecycleBoundaryKind.PrRaised,
      evidenceId: "pr-open-1",
    });
  });

  it("treats SessionEnd events as a closing boundary", () => {
    const segments = deriveBranchLifecyclePhaseSegments({
      sessionStartedAt: "2026-07-22T12:00:00.000Z",
      events: [
        event(
          BranchLifecycleBoundaryKind.BranchWrite,
          "2026-07-22T12:05:00.000Z",
          "build-write"
        ),
        event(
          BranchLifecycleBoundaryKind.SessionEnd,
          "2026-07-22T12:15:00.000Z",
          "end"
        ),
        event(
          BranchLifecycleBoundaryKind.BranchWrite,
          "2026-07-22T12:20:00.000Z",
          "after-end"
        ),
      ],
    });

    expect(segments).toMatchObject([
      {
        sequence: 0,
        phase: BranchLifecyclePhase.Build,
        endedAt: "2026-07-22T12:15:00.000Z",
        endBoundary: {
          kind: BranchLifecycleBoundaryKind.SessionEnd,
          evidenceId: "end",
        },
        evidenceIds: ["build-write"],
      },
    ]);
  });

  it("sorts by timestamp and then input order for deterministic same-session segments", () => {
    const segments = deriveBranchLifecyclePhaseSegments({
      events: [
        event(
          BranchLifecycleBoundaryKind.BranchWrite,
          "2026-07-22T12:20:00.000Z",
          "second"
        ),
        event(
          BranchLifecycleBoundaryKind.PrRaised,
          "2026-07-22T12:10:00.000Z",
          "first"
        ),
        event(BranchLifecycleBoundaryKind.ReadOnlyReference, null, "missing-1"),
        event(BranchLifecycleBoundaryKind.BranchWrite, null, "missing-2"),
      ],
    });

    expect(segments.map((segment) => segment.phase)).toEqual([
      BranchLifecyclePhase.Build,
      BranchLifecyclePhase.Rework,
      BranchLifecyclePhase.Unknown,
      BranchLifecyclePhase.Rework,
    ]);
    expect(segments.map((segment) => segment.sequence)).toEqual([0, 1, 2, 3]);
    expect(segments.at(2)?.evidenceIds).toEqual(["missing-1"]);
    expect(segments.at(3)?.evidenceIds).toEqual(["missing-2"]);
  });

  it("normalizes populated segments by explicit sequence", () => {
    const segments = normalizeBranchLifecyclePhaseSegments([
      segment(2, BranchLifecyclePhase.Unknown),
      segment(0, BranchLifecyclePhase.Build),
      segment(1, BranchLifecyclePhase.Review),
    ]);

    expect(segments.map((item) => item.phase)).toEqual([
      BranchLifecyclePhase.Build,
      BranchLifecyclePhase.Review,
      BranchLifecyclePhase.Unknown,
    ]);
  });
});

function event(
  kind: BranchLifecyclePhaseEvent["kind"],
  observedAt: string | null,
  evidenceId: string
): BranchLifecyclePhaseEvent {
  return {
    kind,
    ...(observedAt ? { observedAt } : {}),
    evidenceId,
  };
}

function segment(sequence: number, phase: BranchLifecyclePhase) {
  return {
    sequence,
    phase,
    startBoundary: { kind: BranchLifecycleBoundaryKind.UnknownEvidence },
  };
}
