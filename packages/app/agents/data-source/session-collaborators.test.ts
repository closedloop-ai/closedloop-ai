import {
  CollaboratorArtifactType,
  unavailableArtifactCollaboratorBatchResponse,
} from "@repo/api/src/types/artifact-collaborators";
import { describe, expect, it, vi } from "vitest";
import { artifactCollaboratorBatchFixture } from "../../shared/__tests__/fixtures/artifact-collaborators";
import { createHttpAgentSessionsDataSource } from "./agent-sessions-data-source";

const SESSION_ID = "55555555-5555-4555-8555-555555555551";

describe("HTTP Session collaborator adapter", () => {
  it("reads the shared batch route for a Cloud Session", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        unavailableArtifactCollaboratorBatchResponse(
          CollaboratorArtifactType.Session,
          [SESSION_ID]
        )
      );
    const source = createHttpAgentSessionsDataSource({ get });

    const response = await source.collaborators?.([SESSION_ID]);

    expect(response?.results[0]?.artifactType).toBe(
      CollaboratorArtifactType.Session
    );
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining("artifactType=SESSION")
    );
  });
});

it("preserves two measured accounts and every Session source state for each requested ID", async () => {
  const ids = [SESSION_ID, "55555555-5555-4555-8555-555555555552"];
  const fixture = artifactCollaboratorBatchFixture(
    CollaboratorArtifactType.Session,
    ids
  );
  const get = vi.fn().mockResolvedValue(fixture);
  const source = createHttpAgentSessionsDataSource({ get });
  expect(await source.collaborators?.(ids)).toEqual(fixture);
  const query = new URL(get.mock.calls[0][0], "https://api.example.test");
  expect(query.pathname).toBe("/artifacts/collaborators");
  expect(query.searchParams.getAll("artifactIds")).toEqual(ids);
  expect(query.searchParams.get("artifactType")).toBe(
    CollaboratorArtifactType.Session
  );
});
