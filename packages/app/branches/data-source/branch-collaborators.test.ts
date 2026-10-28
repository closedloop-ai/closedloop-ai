import {
  CollaboratorArtifactType,
  unavailableArtifactCollaboratorBatchResponse,
} from "@repo/api/src/types/artifact-collaborators";
import { describe, expect, it, vi } from "vitest";
import { createHttpBranchesDataSource } from "./branches-data-source";

const BRANCH_ID = "55555555-5555-4555-8555-555555555551";

describe("HTTP Branch collaborator adapter", () => {
  it("reads the shared batch route for a Cloud Branch", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        unavailableArtifactCollaboratorBatchResponse(
          CollaboratorArtifactType.Branch,
          [BRANCH_ID]
        )
      );
    const source = createHttpBranchesDataSource({ get });

    const response = await source.collaborators?.([BRANCH_ID]);

    expect(response?.results[0]?.artifactType).toBe(
      CollaboratorArtifactType.Branch
    );
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining("artifactType=BRANCH")
    );
  });
});
