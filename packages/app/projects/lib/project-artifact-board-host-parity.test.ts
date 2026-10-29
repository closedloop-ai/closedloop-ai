import {
  CONTEXTUAL_SURFACE_REGISTRY,
  ContextualRouteFamilyId,
} from "@repo/app/shared/lib/complete-surface-contextual-registry";
import { SurfaceMastery } from "@repo/app/shared/lib/complete-surface-registry";
import { describe, expect, it } from "vitest";

describe("CT-13 AC-009 Project Artifact Board paired-host boundary", () => {
  it("records the shared Project Detail body on both web and Desktop hosts", () => {
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
