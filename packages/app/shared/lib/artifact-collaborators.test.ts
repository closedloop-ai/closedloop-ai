import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ARTIFACT_COLLABORATOR_BATCH_MAX_IDS,
  ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE,
  CollaboratorArtifactType,
  unavailableArtifactCollaboratorBatchResponse,
} from "@repo/api/src/types/artifact-collaborators";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/api-error";
import { readArtifactCollaborators } from "./artifact-collaborators";

const ARTIFACT_ID = "55555555-5555-4555-8555-555555555551";
const OTHER_ID = "55555555-5555-4555-8555-555555555552";

describe("readArtifactCollaborators", () => {
  it("splits an oversized ID group without losing either artifact or retrying unrelated failures", async () => {
    const get = vi.fn((path: string) => {
      const ids = new URL(path, "https://api.example.test").searchParams.getAll(
        "artifactIds"
      );
      if (ids.length > 1) {
        return Promise.reject(
          new ApiError("Too large", 413, {
            code: ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE,
          })
        );
      }
      return Promise.resolve(
        unavailableArtifactCollaboratorBatchResponse(
          CollaboratorArtifactType.Branch,
          ids
        )
      );
    });
    const result = await readArtifactCollaborators(
      { get },
      CollaboratorArtifactType.Branch,
      [ARTIFACT_ID, OTHER_ID]
    );
    expect(result?.results.map((entry) => entry.artifactId)).toEqual([
      ARTIFACT_ID,
      OTHER_ID,
    ]);
    expect(get).toHaveBeenCalledTimes(3);
    const rejected = vi
      .fn()
      .mockRejectedValue(new ApiError("Different failure", 413));
    await expect(
      readArtifactCollaborators(
        { get: rejected },
        CollaboratorArtifactType.Branch,
        [ARTIFACT_ID, OTHER_ID]
      )
    ).rejects.toThrow("Different failure");
    expect(rejected).toHaveBeenCalledTimes(1);
  });
  it("rejects a retried subgroup returning an ID from its sibling subgroup", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("Too large", 413, {
          code: ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE,
        })
      )
      .mockResolvedValueOnce(
        unavailableArtifactCollaboratorBatchResponse(
          CollaboratorArtifactType.Branch,
          [OTHER_ID]
        )
      );

    await expect(
      readArtifactCollaborators({ get }, CollaboratorArtifactType.Branch, [
        ARTIFACT_ID,
        OTHER_ID,
      ])
    ).rejects.toThrow("Unexpected collaborator batch identity");
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("sends one repeated-parameter request for a Branch page", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        unavailableArtifactCollaboratorBatchResponse(
          CollaboratorArtifactType.Branch,
          [ARTIFACT_ID, OTHER_ID]
        )
      );

    const response = await readArtifactCollaborators(
      { get },
      CollaboratorArtifactType.Branch,
      [ARTIFACT_ID, OTHER_ID]
    );

    expect(get).toHaveBeenCalledOnce();
    const path = get.mock.calls[0]?.[0] as string;
    const url = new URL(path, "https://api.example.test");
    expect(url.pathname).toBe("/artifacts/collaborators");
    expect(url.searchParams.get("artifactType")).toBe(ArtifactType.Branch);
    expect(url.searchParams.getAll("artifactIds")).toEqual([
      ARTIFACT_ID,
      OTHER_ID,
    ]);
    expect(response?.results).toHaveLength(2);
  });

  it("follows every bounded page instead of dropping IDs after the first", async () => {
    const artifactIds = Array.from(
      { length: ARTIFACT_COLLABORATOR_BATCH_MAX_IDS + 1 },
      (_, index) => `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`
    );
    const get = vi.fn((path: string) => {
      const url = new URL(path, "https://api.example.test");
      return Promise.resolve(
        unavailableArtifactCollaboratorBatchResponse(
          CollaboratorArtifactType.Session,
          url.searchParams.getAll("artifactIds")
        )
      );
    });

    const response = await readArtifactCollaborators(
      { get },
      CollaboratorArtifactType.Session,
      artifactIds
    );

    expect(get).toHaveBeenCalledTimes(2);
    expect(response?.results.map((entry) => entry.artifactId)).toEqual(
      artifactIds
    );
  });

  it("returns request-wide unavailable for a version-skewed server without the route", async () => {
    const get = vi.fn().mockRejectedValue(new ApiError("Missing", 404));

    await expect(
      readArtifactCollaborators({ get }, CollaboratorArtifactType.Session, [
        ARTIFACT_ID,
      ])
    ).resolves.toBeNull();
  });

  it("propagates a current server failure instead of making it complete-empty", async () => {
    const get = vi.fn().mockRejectedValue(new ApiError("Failed", 500));

    await expect(
      readArtifactCollaborators({ get }, CollaboratorArtifactType.Branch, [
        ARTIFACT_ID,
      ])
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects an unrequested artifact identity in the cloud response", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        unavailableArtifactCollaboratorBatchResponse(
          CollaboratorArtifactType.Session,
          [OTHER_ID]
        )
      );

    await expect(
      readArtifactCollaborators({ get }, CollaboratorArtifactType.Session, [
        ARTIFACT_ID,
      ])
    ).rejects.toThrow("Unexpected collaborator batch identity");
  });
});
