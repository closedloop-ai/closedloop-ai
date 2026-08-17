import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import { createAgentSessionListItemFixture } from "../../sessions/session-list-fixtures";
import {
  AgentSessionActivityStatus,
  projectAgentSessionActivities,
} from "../activity-projection";

describe("projectAgentSessionActivities", () => {
  it("maps ownership-matrix fields from list rows and wrapper href callbacks", () => {
    const row = createAgentSessionListItemFixture({
      id: "session-activity-1",
      name: null,
      externalSessionId: "external-activity",
      status: SESSION_STATUS.ACTIVE,
      awaitingInputSince: new Date("2026-06-01T10:00:00.000Z"),
      updatedAt: new Date("2026-06-01T10:05:00.000Z"),
      summary: "Needs reviewer input",
    });

    const [activity] = projectAgentSessionActivities([row], {
      getSessionHref: (sessionId) => `/sessions/${sessionId}`,
    });

    expect(activity).toMatchObject({
      activityId: "session-activity-1:awaiting-input",
      label: "external-activity",
      sessionHref: "/sessions/session-activity-1",
      sessionId: "session-activity-1",
      status: AgentSessionActivityStatus.AwaitingInput,
      summary: "Needs reviewer input",
    });
    expect(activity?.metadata).toContainEqual({
      label: "Repository",
      value: "closedloop-ai/symphony-alpha",
    });
  });

  it("applies timestamp precedence, missing-id exclusion, unknown fallback, and stable tie ordering", () => {
    const first = createAgentSessionListItemFixture({
      id: "first",
      lastActivityAt: new Date("2026-06-03T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    const second = createAgentSessionListItemFixture({
      id: "second",
      status: "mystery",
      updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    });
    const tie = createAgentSessionListItemFixture({
      id: "tie",
      updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    });
    const noId = createAgentSessionListItemFixture({ id: undefined });

    const activities = projectAgentSessionActivities([
      second,
      noId,
      first,
      tie,
    ]);

    expect(activities.map((activity) => activity.sessionId)).toEqual([
      "first",
      "second",
      "tie",
    ]);
    expect(activities[0]?.timestamp?.toISOString()).toBe(
      "2026-06-03T00:00:00.000Z"
    );
    expect(activities[1]?.status).toBe(AgentSessionActivityStatus.Updated);
    expect(activities[1]?.summary).toBe("Session updated");
  });

  it("classifies an inactive session as Inactive, not the Updated catch-all (ISS-4586)", () => {
    const [activity] = projectAgentSessionActivities([
      createAgentSessionListItemFixture({
        id: "inactive-session",
        status: SESSION_STATUS.INACTIVE,
        awaitingInputSince: null,
        updatedAt: new Date("2026-06-01T10:05:00.000Z"),
      }),
    ]);

    expect(activity?.status).toBe(AgentSessionActivityStatus.Inactive);
    expect(activity?.status).not.toBe(AgentSessionActivityStatus.Updated);
    expect(activity?.summary).toBe("Session ended");
  });

  it("renders a non-link fallback and does not copy raw event data into summaries", () => {
    const [activity] = projectAgentSessionActivities([
      createAgentSessionListItemFixture({
        data: { secret: "raw event payload" },
        externalSessionId: null,
        id: "fallback-session",
        name: null,
        status: null,
        updatedAt: null,
      }),
    ]);

    expect(activity?.label).toBe("Session fallback");
    expect(activity?.sessionHref).toBeNull();
    expect(activity?.status).toBe(AgentSessionActivityStatus.Updated);
    expect(activity?.summary).toBe("Session updated");
    expect(activity?.summary).not.toContain("raw event payload");
  });

  it.each([
    [SESSION_STATUS.ERROR, AgentSessionActivityStatus.Failed, "Session failed"],
    // Version-skew alias accepted by the projection but not emitted canonically.
    ["failed", AgentSessionActivityStatus.Failed, "Session failed"],
    [
      SESSION_STATUS.ACTIVE,
      AgentSessionActivityStatus.Active,
      "Session is active",
    ],
  ])("projects the %s status fallback", (status, expectedStatus, summary) => {
    const [activity] = projectAgentSessionActivities([
      createAgentSessionListItemFixture({
        id: `${status}-session`,
        status,
        summary: null,
      }),
    ]);

    expect(activity).toMatchObject({ status: expectedStatus, summary });
  });

  it("falls back through completed and created timestamps, then keeps undated rows stable", () => {
    const activities = projectAgentSessionActivities([
      createAgentSessionListItemFixture({
        id: "invalid",
        lastActivityAt: "not-a-date",
        updatedAt: "also-not-a-date",
        completedAt: "still-not-a-date",
        createdAt: "invalid-too",
      }),
      createAgentSessionListItemFixture({
        id: "created",
        lastActivityAt: null,
        updatedAt: null,
        completedAt: null,
        createdAt: "2026-06-03T00:00:00.000Z",
      }),
      createAgentSessionListItemFixture({
        id: "undated",
        lastActivityAt: null,
        updatedAt: null,
        completedAt: null,
        createdAt: null,
      }),
      createAgentSessionListItemFixture({
        id: "completed",
        lastActivityAt: null,
        updatedAt: null,
        completedAt: "2026-06-04T00:00:00.000Z",
        createdAt: "2026-06-02T00:00:00.000Z",
      }),
    ]);

    expect(
      activities.map(({ sessionHref, sessionId, timestampLabel }) => ({
        sessionHref,
        sessionId,
        timestampLabel,
      }))
    ).toEqual([
      {
        sessionHref: null,
        sessionId: "completed",
        timestampLabel: "2026-06-04T00:00:00.000Z",
      },
      {
        sessionHref: null,
        sessionId: "created",
        timestampLabel: "2026-06-03T00:00:00.000Z",
      },
      { sessionHref: null, sessionId: "invalid", timestampLabel: "Undated" },
      { sessionHref: null, sessionId: "undated", timestampLabel: "Undated" },
    ]);
    expect(activities.slice(2).map(({ timestamp }) => timestamp)).toEqual([
      null,
      null,
    ]);
  });

  it("falls back from a blank label and includes only populated metadata", () => {
    const [withMetadata, withoutMetadata] = projectAgentSessionActivities([
      createAgentSessionListItemFixture({
        id: "with-metadata",
        project: { name: "Agents" },
      }),
      createAgentSessionListItemFixture({
        computeTarget: null,
        externalSessionId: "unused-external-id",
        id: "blank-label-session",
        name: "   ",
        project: null,
        repositoryFullName: null,
        sourceArtifact: null,
      }),
    ]);

    expect(withMetadata?.metadata).toEqual([
      { label: "Repository", value: "closedloop-ai/symphony-alpha" },
      { label: "Project", value: "Agents" },
      { label: "Compute target", value: "MacBook Pro" },
      { label: "Artifact", value: "Desktop MLP" },
    ]);
    expect(withoutMetadata).toMatchObject({
      label: "Session blank-la",
      metadata: [],
    });
  });
});
