import {
  CollaboratorArtifactType,
  unavailableArtifactCollaboratorBatchResponse,
} from "@repo/api/src/types/artifact-collaborators";
import { describe, expect, it } from "vitest";
import { branchRowsWithArtifactInteractions } from "../branch-artifact-interactions";
import { branchRow } from "./branch-row-fixture";

describe("Branch common artifact interaction projection", () => {
  it("preserves extra branch collaborators while adding measured comments", () => {
    const row = branchRow({
      collaborators: [{ key: "github:author", name: "Author" }],
    });
    const [entry] = unavailableArtifactCollaboratorBatchResponse(
      CollaboratorArtifactType.Branch,
      [row.id]
    ).results;
    const [result] = branchRowsWithArtifactInteractions(
      [row],
      new Map([[row.id, { ...entry, commentCount: 3 }]])
    );
    expect(result.commentCount).toBe(3);
    expect(result.collaborators).toEqual(row.collaborators);
  });
  it("keeps unknown evidence unknown and retains a measured zero", () => {
    const row = branchRow();
    expect(branchRowsWithArtifactInteractions([row], undefined)[0]).toBe(row);
    const [entry] = unavailableArtifactCollaboratorBatchResponse(
      CollaboratorArtifactType.Branch,
      [row.id]
    ).results;
    expect(
      branchRowsWithArtifactInteractions([row], new Map([[row.id, entry]]))[0]
        .commentCount
    ).toBeNull();
    expect(
      branchRowsWithArtifactInteractions(
        [row],
        new Map([[row.id, { ...entry, commentCount: 0 }]])
      )[0].commentCount
    ).toBe(0);
  });
});
