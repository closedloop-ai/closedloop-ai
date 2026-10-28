import {
  CONTEXTUAL_SURFACE_REGISTRY,
  ContextualRouteFamilyId,
} from "@repo/app/shared/lib/complete-surface-contextual-registry";
import { SurfaceMastery } from "@repo/app/shared/lib/complete-surface-registry";
import { describe, expect, it } from "vitest";
import { matchRoute, NavId } from "../route-table";

describe("CT-10 Project Artifact Board Desktop host boundary", () => {
  it("maps the team-scoped Project Detail path without adding a top-level Projects route", () => {
    expect(matchRoute("/projects/project-1")).toBeNull();
    expect(matchRoute("/teams/team-1/projects/project-1")).toMatchObject({
      kind: "project-context",
      teamId: "team-1",
      projectId: "project-1",
      archived: false,
    });
    expect(Object.values(NavId)).not.toContain("projects");
  });

  it("records the shared Project Detail body on both web and Desktop", () => {
    expect(
      CONTEXTUAL_SURFACE_REGISTRY[ContextualRouteFamilyId.ProjectContext]
    ).toMatchObject({
      mastery: SurfaceMastery.Partial,
      webHost:
        "apps/app/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/page.tsx",
      desktopHost:
        "apps/desktop/src/renderer/components/projects/project-context-view.tsx",
    });
  });
});
