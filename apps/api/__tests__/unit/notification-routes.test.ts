import { DocumentType } from "@repo/api/src/types/document";
import {
  getNotificationEntityPath,
  NotificationEntityKind,
} from "@repo/api/src/types/notification-routes";
import { describe, expect, it } from "vitest";

describe("getNotificationEntityPath", () => {
  describe("artifact", () => {
    it("routes PRDs to /prds/<slug>", () => {
      expect(
        getNotificationEntityPath({
          kind: NotificationEntityKind.Artifact,
          slug: "PRD-7",
          subtype: DocumentType.Prd,
        })
      ).toBe("/prds/PRD-7");
    });

    it("routes implementation plans to /implementation-plans/<slug>", () => {
      expect(
        getNotificationEntityPath({
          kind: NotificationEntityKind.Artifact,
          slug: "PLN-12",
          subtype: DocumentType.ImplementationPlan,
        })
      ).toBe("/implementation-plans/PLN-12");
    });

    it("routes features to /features/<slug>", () => {
      expect(
        getNotificationEntityPath({
          kind: NotificationEntityKind.Artifact,
          slug: "FEA-877",
          subtype: DocumentType.Feature,
        })
      ).toBe("/features/FEA-877");
    });

    it("falls back to /documents/<slug> for unknown subtypes", () => {
      expect(
        getNotificationEntityPath({
          kind: NotificationEntityKind.Artifact,
          slug: "TPL-3",
          subtype: DocumentType.Template,
        })
      ).toBe("/documents/TPL-3");
    });
  });

  it("routes workstreams to /workstreams/<id>", () => {
    expect(
      getNotificationEntityPath({
        kind: NotificationEntityKind.Workstream,
        workstreamId: "ws-123",
      })
    ).toBe("/workstreams/ws-123");
  });

  it("routes projects to /teams/<teamId>/projects/<projectId>", () => {
    expect(
      getNotificationEntityPath({
        kind: NotificationEntityKind.Project,
        teamId: "team-1",
        projectId: "proj-2",
      })
    ).toBe("/teams/team-1/projects/proj-2");
  });
});
