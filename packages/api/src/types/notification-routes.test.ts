import { describe, expect, it } from "vitest";
import {
  getNotificationEntityPath,
  NotificationEntityKind,
} from "./notification-routes";

describe("getNotificationEntityPath", () => {
  it("builds the session deep-link path from a session id (FEA-2858)", () => {
    expect(
      getNotificationEntityPath({
        kind: NotificationEntityKind.Session,
        sessionId: "abc-123",
      })
    ).toBe("/sessions/abc-123");
  });

  it("still builds the loop deep-link path", () => {
    expect(
      getNotificationEntityPath({
        kind: NotificationEntityKind.Loop,
        loopId: "loop-9",
      })
    ).toBe("/loops/loop-9");
  });

  it("still builds the project deep-link path", () => {
    expect(
      getNotificationEntityPath({
        kind: NotificationEntityKind.Project,
        teamId: "team-1",
        projectId: "proj-2",
      })
    ).toBe("/teams/team-1/projects/proj-2");
  });
});
