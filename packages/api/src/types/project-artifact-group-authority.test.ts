import { describe, expect, it } from "vitest";
import { ArtifactType } from "./artifact.ts";
import { projectArtifactTypeSupportsGroupField } from "./project-artifact-group-authority.ts";
import { ProjectArtifactPlacementGroupField } from "./project-artifact-placement.ts";

describe("project artifact group authority", () => {
  it.each([
    [ArtifactType.Document, true, true, true],
    [ArtifactType.Branch, false, true, false],
    [ArtifactType.Deployment, false, false, false],
    [ArtifactType.Session, true, true, false],
  ] as const)(
    "classifies %s field writes",
    (type, assigneeId, priority, status) => {
      expect(
        projectArtifactTypeSupportsGroupField(
          type,
          ProjectArtifactPlacementGroupField.AssigneeId
        )
      ).toBe(assigneeId);
      expect(
        projectArtifactTypeSupportsGroupField(
          type,
          ProjectArtifactPlacementGroupField.Priority
        )
      ).toBe(priority);
      expect(
        projectArtifactTypeSupportsGroupField(
          type,
          ProjectArtifactPlacementGroupField.Status
        )
      ).toBe(status);
    }
  );

  it("refuses a recognized field when the artifact kind is unavailable", () => {
    expect(
      projectArtifactTypeSupportsGroupField(
        undefined,
        ProjectArtifactPlacementGroupField.AssigneeId
      )
    ).toBe(false);
  });
});
