import { DocumentType } from "@repo/api/src/types/document";
import {
  getNotificationEntityPath,
  isArtifactRoutePrefix,
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

    // FEA-4137: Feature (Issue) notifications route under /issues/; the FEA-
    // slug stays valid as a compat alias.
    it("routes features to /issues/<slug>", () => {
      expect(
        getNotificationEntityPath({
          kind: NotificationEntityKind.Artifact,
          slug: "FEA-877",
          subtype: DocumentType.Feature,
        })
      ).toBe("/issues/FEA-877");
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

  it("routes projects to /teams/<teamId>/projects/<projectId>", () => {
    expect(
      getNotificationEntityPath({
        kind: NotificationEntityKind.Project,
        teamId: "team-1",
        projectId: "proj-2",
      })
    ).toBe("/teams/team-1/projects/proj-2");
  });

  it("routes loops to /loops/<loopId>", () => {
    expect(
      getNotificationEntityPath({
        kind: NotificationEntityKind.Loop,
        loopId: "loop-9",
      })
    ).toBe("/loops/loop-9");
  });
});

describe("isArtifactRoutePrefix", () => {
  it("recognizes the canonical artifact-detail prefixes", () => {
    expect(isArtifactRoutePrefix("prds")).toBe(true);
    expect(isArtifactRoutePrefix("implementation-plans")).toBe(true);
    // FEA-4137: Issue is the canonical Feature prefix now.
    expect(isArtifactRoutePrefix("issues")).toBe(true);
    expect(isArtifactRoutePrefix("documents")).toBe(true);
  });

  // FEA-4137: the retired `/features/` prefix must keep resolving so old
  // deep-links (external bookmarks, push notifications minted before the
  // rename) still land on the artifact-detail screen. Dropping it silently
  // broke the mobile navigation adapter's `resolveRouteFromHref`.
  it("still recognizes the legacy /features/ prefix as a compat alias", () => {
    expect(isArtifactRoutePrefix("features")).toBe(true);
  });

  it("rejects non-artifact prefixes", () => {
    expect(isArtifactRoutePrefix("loops")).toBe(false);
    expect(isArtifactRoutePrefix("branches")).toBe(false);
  });
});
