import { describe, expect, it } from "vitest";
import { branchRows } from "./mock";
import { buildBranchDetail } from "./mock-detail";
import {
  projectTimelineCompleteness,
  resolveTimelineCompletenessFixture,
  TimelineCompletenessState,
  TimelineFixtureBranchId,
} from "./timeline-completeness-fixtures";

const TIMING_BRANCH_IDS = Object.values(TimelineFixtureBranchId);

describe("timeline completeness fixtures", () => {
  it("projects the four selectable Branch rows into the approved timing states", () => {
    expect(
      TIMING_BRANCH_IDS.map((id) => requiredFixture(detailFor(id)).state)
    ).toEqual([
      TimelineCompletenessState.Complete,
      TimelineCompletenessState.MixedTimingUnavailable,
      TimelineCompletenessState.TimelineLimitOmitted,
      TimelineCompletenessState.TimingUnavailable,
    ]);
  });

  it("models COMMON-002 eligibility from explicit project and SessionDetail links", () => {
    for (const id of TIMING_BRANCH_IDS) {
      const detail = detailFor(id);
      const fixtureValue = requiredFixture(detail);
      const source = fixtureValue.eligibility;

      expect(source.branchArtifact.branchId).toBe(detail.id);
      expect(source.branchArtifact.branchName).toBe(detail.branchName);
      expect(source.branchArtifact.projectId).not.toBe("");
      expect(source.repository.fullName).toBe(detail.repoFullName);
      expect(source.repository.defaultBranch).toBe(rowFor(id).baseBranch);
      expect(source.branchArtifact.repositoryId).toBe(source.repository.id);
      expect(source.sessionDetails.map(({ laneId }) => laneId)).toEqual(
        detail.sessions.map(({ id: sessionId }) => sessionId)
      );
      expect(
        source.sessionDetails.every(
          ({ branchId, laneId, projectId, repositoryId, sourceSessionId }) =>
            branchId === detail.id &&
            projectId === source.branchArtifact.projectId &&
            repositoryId === source.repository.id &&
            sourceSessionId === `${detail.id}:${laneId}`
        )
      ).toBe(true);
    }

    const nonAgentDetail = detailFor("br_session_cost");
    expect(nonAgentDetail.branchName.startsWith("agent/")).toBe(false);
    expect(
      requiredFixture(nonAgentDetail).eligibility.sessionDetails
    ).toHaveLength(1);
  });

  it("does not fabricate eligibility evidence for an unregistered Branch", () => {
    const detail = buildBranchDetail(branchRows[0]);

    expect(resolveTimelineCompletenessFixture(detail)).toBeNull();
    expect(projectTimelineCompleteness(detail).disclosure).toBeNull();
  });

  it("keeps lifetime LOC per dollar separate from rendered timing subtotals", () => {
    const mixed = detailFor("br_saml");
    const mixedProjection = projectTimelineCompleteness(mixed);
    const truncated = detailFor("br_dark_mode");
    const truncatedProjection = projectTimelineCompleteness(truncated);

    expect(mixedProjection.costLabel).toBe("$1,200*");
    expect(mixedProjection.durationLabel).toBe("3h 46m*");
    expect(mixed.valuePerDollar).toBe("0.48");
    expect(mixedProjection.disclosure).toBe(
      "* Timing is unavailable for assertion review follow-up. Cost and duration include only rendered activity with timing data."
    );
    expect(mixedProjection.timeline.columns).not.toEqual(
      mixed.timeline.columns
    );
    expect(
      mixedProjection.timeline.columns.some((column, index) => {
        const sourceColumn = mixed.timeline.columns[index];
        return (
          sourceColumn !== undefined &&
          column.tokens.cacheRead < sourceColumn.tokens.cacheRead
        );
      })
    ).toBe(true);
    expect(truncatedProjection.costLabel).toBe("$221*");
    expect(truncatedProjection.durationLabel).toBe("1h 12m*");
    expect(truncatedProjection.disclosure).toBe(
      "* The 90-day timeline limit omits later activity for design-system-dark-mode-2. Cost and duration include only rendered activity with timing data."
    );
  });

  it("keeps complete evidence intact and removes only indefensible bars", () => {
    const complete = detailFor("br_1281");
    const completeProjection = projectTimelineCompleteness(complete);
    const unavailable = detailFor("br_session_cost");
    const unavailableProjection = projectTimelineCompleteness(unavailable);

    expect(completeProjection.costLabel).toBe(complete.costLabel);
    expect(completeProjection.durationLabel).toBe(complete.wallClockLabel);
    expect(completeProjection.disclosure).toBeNull();
    expect(completeProjection.timeline).toBe(complete.timeline);
    expect(unavailableProjection.costLabel).toBe("Unavailable");
    expect(unavailableProjection.durationLabel).toBe("Unavailable");
    expect(unavailableProjection.timeline.columns).toEqual([]);
    expect(unavailableProjection.noBarsMessage).toBe(
      "Session timing is unavailable, so spend can't be charted by hour."
    );
  });

  it("puts stable Session IDs on the real omission-state timeline segments", () => {
    for (const id of [
      TimelineFixtureBranchId.MixedTimingUnavailable,
      TimelineFixtureBranchId.TimelineLimitOmitted,
      TimelineFixtureBranchId.TimingUnavailable,
    ]) {
      const detail = detailFor(id);
      const sourceSessionIds = new Set(detail.sessions.map(({ id }) => id));
      const segmentSessionIds = detail.timeline.columns.flatMap(
        ({ segments }) => segments.map(({ sessionId }) => sessionId)
      );

      expect(segmentSessionIds.length).toBeGreaterThan(0);
      expect(segmentSessionIds).not.toContain(undefined);
      expect(
        segmentSessionIds.every(
          (sessionId) => sessionId && sourceSessionIds.has(sessionId)
        )
      ).toBe(true);
    }
  });

  it("omits the named real-fixture Session by identity when palette colors collide", () => {
    const mixed = detailFor(TimelineFixtureBranchId.MixedTimingUnavailable);
    const sharedColor = mixed.sessions[0]?.color ?? "var(--chart-1)";
    const detail = {
      ...mixed,
      sessions: mixed.sessions.map((session) => ({
        ...session,
        color: sharedColor,
      })),
      timeline: {
        ...mixed.timeline,
        columns: mixed.timeline.columns.map((column) => ({
          ...column,
          segments: column.segments.map((segment) => ({
            ...segment,
            color: sharedColor,
          })),
        })),
      },
    };

    const projection = projectTimelineCompleteness(detail);
    const sourceSegments = detail.timeline.columns.flatMap(
      ({ segments }) => segments
    );
    const renderedSegments = projection.timeline.columns.flatMap(
      ({ segments }) => segments
    );

    expect(sourceSegments.some(({ sessionId }) => sessionId === "s3")).toBe(
      true
    );
    expect(renderedSegments.some(({ sessionId }) => sessionId === "s3")).toBe(
      false
    );
    expect(renderedSegments.some(({ sessionId }) => sessionId === "s1")).toBe(
      true
    );
    expect(renderedSegments.some(({ sessionId }) => sessionId === "s2")).toBe(
      true
    );
    expect(projection.disclosure).toContain("assertion review follow-up");
  });

  it("removes hidden token totals when every segment in a column is omitted", () => {
    const mixed = detailFor(TimelineFixtureBranchId.MixedTimingUnavailable);
    const sourceColumn = mixed.timeline.columns.find(
      ({ idle, segments }) => !idle && segments.length > 0
    );
    expect(sourceColumn).toBeDefined();
    if (!sourceColumn) {
      return;
    }
    const detail = {
      ...mixed,
      timeline: {
        ...mixed.timeline,
        columns: [
          {
            ...sourceColumn,
            segments: sourceColumn.segments.map((segment) => ({
              ...segment,
              sessionId: "s3",
            })),
          },
        ],
      },
    };

    const projection = projectTimelineCompleteness(detail);

    expect(projection.timeline.columns[0]).toMatchObject({
      idle: true,
      segments: [],
      tokens: { input: 0, output: 0, cacheRead: 0 },
    });
  });
});

function detailFor(id: (typeof TIMING_BRANCH_IDS)[number]) {
  return buildBranchDetail(rowFor(id));
}

function rowFor(id: (typeof TIMING_BRANCH_IDS)[number]) {
  const row = branchRows.find((candidate) => candidate.id === id);
  if (!row) {
    throw new Error(`Missing selectable Branch fixture ${id}`);
  }
  return row;
}

function requiredFixture(detail: ReturnType<typeof detailFor>) {
  const fixtureValue = resolveTimelineCompletenessFixture(detail);
  if (!fixtureValue) {
    throw new Error(`Missing timing fixture ${detail.id}`);
  }
  return fixtureValue;
}
