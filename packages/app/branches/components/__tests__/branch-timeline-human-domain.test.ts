import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
} from "@repo/api/src/types/branch-trace";
import { chartColorPairForTokenIndex } from "@repo/design-system/components/ui/chart-colors";
import { describe, expect, it } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import { buildTimelineHumanActorDomain } from "../branch-timeline-human-domain";

describe("buildTimelineHumanActorDomain", () => {
  it("gives the earliest rendered human conversation blue without letting Unattributed consume priority", () => {
    const detail = makeBranchDetail({
      mergedTrace: [
        prompt("maya", "2026-06-10T09:00:00.000Z", "Maya"),
        prompt("lee", "2026-06-10T09:03:00.000Z", "Lee"),
      ],
      sessions: [
        makeBranchSession({
          sessionId: "unknown",
          startedAt: "2026-06-10T08:55:00.000Z",
          ownerUserName: null,
        }),
        makeBranchSession({
          sessionId: "maya",
          startedAt: "2026-06-10T09:00:00.000Z",
          ownerUserId: "user-maya",
          ownerUserName: "Maya",
        }),
        makeBranchSession({
          sessionId: "lee",
          startedAt: "2026-06-10T09:03:00.000Z",
          ownerUserId: "user-lee",
          ownerUserName: "Lee",
          isPrimary: true,
        }),
      ],
    });

    const domain = buildTimelineHumanActorDomain(detail);

    expect(domain.ordered).toEqual(["Maya", "Lee"]);
    expect(domain.colorFor("Maya")).toBe(chartColorPairForTokenIndex(1).base);
  });

  it("uses canonical user identity to break equal-time ties", () => {
    const detail = makeBranchDetail({
      mergedTrace: [
        prompt("b", "2026-06-10T10:00:00.000Z", "First in array"),
        prompt("a", "2026-06-10T10:00:00.000Z", "Second in array"),
      ],
      sessions: [
        makeBranchSession({
          sessionId: "b",
          ownerUserId: "actor-b",
          ownerUserName: "First in array",
        }),
        makeBranchSession({
          sessionId: "a",
          ownerUserId: "actor-a",
          ownerUserName: "Second in array",
        }),
      ],
    });

    expect(buildTimelineHumanActorDomain(detail).ordered).toEqual([
      "Second in array",
      "First in array",
    ]);
  });

  it("exhausts every chart token before cycling", () => {
    const sessions = Array.from({ length: 11 }, (_, index) =>
      makeBranchSession({
        sessionId: `session-${index}`,
        startedAt: new Date(Date.UTC(2026, 5, 10, 10, index)).toISOString(),
        ownerUserId: `actor-${String(index).padStart(2, "0")}`,
        ownerUserName: `Actor ${index}`,
      })
    );
    const domain = buildTimelineHumanActorDomain(
      makeBranchDetail({
        sessions,
        mergedTrace: sessions.map((session, index) =>
          prompt(
            session.sessionId,
            new Date(Date.UTC(2026, 5, 10, 10, index)).toISOString(),
            session.ownerUserName
          )
        ),
      })
    );
    const firstTen = sessions
      .slice(0, 10)
      .map((session) => domain.colorFor(session.ownerUserName));

    expect(new Set(firstTen).size).toBe(10);
    expect(domain.colorFor("Actor 10")).toBe(domain.colorFor("Actor 1"));
  });

  it("keeps distinct canonical users separate when their display names match", () => {
    const detail = makeBranchDetail({
      mergedTrace: [
        prompt("one", "2026-06-10T10:00:00.000Z", "Sam"),
        prompt("two", "2026-06-10T10:01:00.000Z", "Sam"),
      ],
      sessions: [
        makeBranchSession({
          sessionId: "one",
          ownerUserId: "user-1",
          ownerUserName: "Sam",
        }),
        makeBranchSession({
          sessionId: "two",
          ownerUserId: "user-2",
          ownerUserName: "Sam",
        }),
      ],
    });
    const domain = buildTimelineHumanActorDomain(detail);
    expect(domain.colorFor("Sam", "user-1")).not.toBe(
      domain.colorFor("Sam", "user-2")
    );
  });

  it("matches loaded hydration by artifact id when the external session id differs", () => {
    const detail = makeBranchDetail({
      mergedTrace: [prompt("artifact-1", "2026-06-10T10:00:00.000Z", "Maya")],
      sessions: [
        makeBranchSession({
          sessionId: "artifact-1",
          ownerUserId: "maya",
          ownerUserName: "Maya",
        }),
      ],
    });
    const state = {
      aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
      completeness: { state: BranchTraceCompletenessState.Complete },
      qualifyingSessionCount: 1,
      sessions: [
        {
          identity: {
            artifactId: "artifact-1",
            externalSessionId: "external-different",
            name: "Maya session",
            navigableRef: "SES-1",
            slug: "SES-1",
          },
          state: BranchTraceSessionHydrationState.Loaded,
        },
      ],
    };

    expect(buildTimelineHumanActorDomain(detail, state).ordered).toEqual([
      "Maya",
    ]);
  });
});

function prompt(sessionId: string, t: string, actorName: string | null) {
  return {
    actorName,
    cumCostUsd: 0,
    sessionId,
    t,
    text: "Steering",
    tMs: Date.parse(t),
    type: "prompt" as const,
  };
}
