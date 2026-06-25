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
      status: "active",
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
});
