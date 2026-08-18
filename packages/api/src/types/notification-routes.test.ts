import { describe, expect, it } from "vitest";
import {
  BranchDetailTabParam,
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

  it("builds the plain branch deep-link path when no tab is requested", () => {
    expect(
      getNotificationEntityPath({
        kind: NotificationEntityKind.Branch,
        branchId: "branch-7",
      })
    ).toBe("/branches/branch-7");
  });

  it("appends ?tab= so a branch mention deep-links to the trace tab (FEA-3490)", () => {
    expect(
      getNotificationEntityPath({
        kind: NotificationEntityKind.Branch,
        branchId: "branch-7",
        tab: BranchDetailTabParam.SessionsTimeline,
      })
    ).toBe("/branches/branch-7?tab=sessions-timeline");
  });
});
