import { ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { describe, expect, it } from "vitest";
import { GenericArtifactKind } from "../../../shared/components/generic-artifact-surface/generic-artifact-status";
import { ARTIFACT_GROUP_NO_VALUE } from "../../../shared/components/generic-artifact-surface/preview/components/artifact-list-grouping";
import { genericArtifacts } from "../../../shared/components/generic-artifact-surface/preview/fixtures";
import {
  projectGroupAuthority,
  projectGroupUpdates,
} from "../project-artifact-group-updates";

function row(
  kind: (typeof GenericArtifactKind)[keyof typeof GenericArtifactKind]
) {
  const source = genericArtifacts[0];
  if (!source) {
    throw new Error("Missing canonical artifact fixture");
  }
  return {
    ...source,
    kind,
    ownerId: "owner",
    owner: "Ada",
    tags: ["Delivery"],
    tagIds: ["tag-id"],
  };
}
describe("project group write authority", () => {
  it("refuses source-derived Branch ownership while keeping Session ownership writable", () => {
    const branch = row(GenericArtifactKind.Branch);
    const session = row(GenericArtifactKind.Session);
    expect(
      projectGroupUpdates(branch, [["owner", "owner"]], [branch])
    ).toBeNull();
    expect(projectGroupAuthority(ArtifactType.Branch, "owner")).toBe(false);
    expect(
      projectGroupUpdates(session, [["owner", "owner"]], [session])
    ).toEqual({ assigneeId: "owner" });
  });
  it("never clears a value for an unknown group identity", () => {
    const issue = row(GenericArtifactKind.Issue);
    expect(
      projectGroupUpdates(issue, [["tags", "Unknown"]], [issue])
    ).toBeNull();
    expect(
      projectGroupUpdates(issue, [["priority", "invalid"]], [issue])
    ).toBeNull();
    expect(
      projectGroupUpdates(issue, [["owner", "missing"]], [issue])
    ).toBeNull();
    expect(
      projectGroupUpdates(issue, [["tags", ARTIFACT_GROUP_NO_VALUE]], [issue])
    ).toEqual({ tagIds: [] });
  });
  it("maps supported priority and tag groups to canonical API values", () => {
    const issue = row(GenericArtifactKind.Issue);
    expect(
      projectGroupUpdates(
        issue,
        [
          ["priority", Priority.High],
          ["tags", "Delivery"],
        ],
        [issue]
      )
    ).toEqual({ priority: Priority.High, tagIds: ["tag-id"] });
    expect(projectGroupAuthority(ArtifactType.Deployment, "priority")).toBe(
      false
    );
  });
});
