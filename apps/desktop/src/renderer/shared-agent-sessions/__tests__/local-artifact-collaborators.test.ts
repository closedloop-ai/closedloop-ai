import {
  CollaboratorArtifactType,
  DirectCollaboratorSource,
  SessionCollaboratorSource,
} from "@repo/api/src/types/artifact-collaborators";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
} from "@repo/api/src/types/branch-identity";
import { describe, expect, it } from "vitest";
import { createLocalBranchesDataSource } from "../../shared-branches/local-branches-data-source";
import { createLocalAgentSessionsDataSource } from "../local-agent-sessions-data-source";

describe("Desktop Local collaborator adapters", () => {
  it("returns unavailable for every Session evidence source", async () => {
    const source = createLocalAgentSessionsDataSource({
      agentSessionsApi: {},
    } as never);

    const response = await source.collaborators?.(["local-session"]);

    expect(response?.results).toEqual([
      {
        artifactId: "local-session",
        artifactType: CollaboratorArtifactType.Session,
        collaborators: {
          availability: BranchIdentityAvailability.Unavailable,
          people: [],
          sources: {
            [SessionCollaboratorSource.Owner]:
              BranchIdentityAvailability.Unavailable,
            [SessionCollaboratorSource.Comments]:
              BranchIdentityAvailability.Unavailable,
            [SessionCollaboratorSource.MetadataEdits]:
              BranchIdentityAvailability.Unavailable,
            [DirectCollaboratorSource.Creator]:
              BranchIdentityAvailability.Unavailable,
            [DirectCollaboratorSource.Interactions]:
              BranchIdentityAvailability.Unavailable,
            [DirectCollaboratorSource.Comments]:
              BranchIdentityAvailability.Unavailable,
          },
        },
      },
    ]);
  });

  it("returns unavailable for every Branch evidence source", async () => {
    const source = createLocalBranchesDataSource({ branchesApi: {} } as never);

    const response = await source.collaborators?.(["local-branch"]);

    expect(response?.results).toEqual([
      {
        artifactId: "local-branch",
        artifactType: CollaboratorArtifactType.Branch,
        collaborators: {
          availability: BranchIdentityAvailability.Unavailable,
          people: [],
          sources: {
            [BranchCollaboratorSource.PullRequestAuthors]:
              BranchIdentityAvailability.Unavailable,
            [BranchCollaboratorSource.Pushes]:
              BranchIdentityAvailability.Unavailable,
            [BranchCollaboratorSource.PullRequestComments]:
              BranchIdentityAvailability.Unavailable,
            [BranchCollaboratorSource.BranchComments]:
              BranchIdentityAvailability.Unavailable,
            [BranchCollaboratorSource.SessionComments]:
              BranchIdentityAvailability.Unavailable,
            [DirectCollaboratorSource.Creator]:
              BranchIdentityAvailability.Unavailable,
            [DirectCollaboratorSource.Interactions]:
              BranchIdentityAvailability.Unavailable,
            [DirectCollaboratorSource.Comments]:
              BranchIdentityAvailability.Unavailable,
          },
        },
      },
    ]);
  });
});
