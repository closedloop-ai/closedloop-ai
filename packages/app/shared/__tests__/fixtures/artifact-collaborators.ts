import {
  type ArtifactCollaboratorBatchResponse,
  CollaboratorArtifactType,
  DirectCollaboratorSource,
  SessionCollaboratorSource,
} from "@repo/api/src/types/artifact-collaborators";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";

/** Same measured Cloud population supplied to web and the Desktop IPC adapter. */
export function artifactCollaboratorBatchFixture(
  artifactType: CollaboratorArtifactType,
  artifactIds: readonly string[]
): ArtifactCollaboratorBatchResponse {
  const people = [
    {
      provider: BranchPersonProvider.ClosedLoop,
      id: "account-a",
      userId: "account-a",
      displayName: "Account A",
    },
    {
      provider: BranchPersonProvider.ClosedLoop,
      id: "account-b",
      userId: "account-b",
      displayName: "Account B",
    },
  ];
  if (artifactType === CollaboratorArtifactType.Session) {
    return {
      results: artifactIds.map((artifactId, index) => ({
        artifactId,
        artifactType,
        collaborators: {
          availability: BranchIdentityAvailability.Complete,
          people: people.slice(
            index % people.length,
            (index % people.length) + 1
          ),
          sources: {
            ...directSources,
            [SessionCollaboratorSource.Owner]:
              BranchIdentityAvailability.Complete,
            [SessionCollaboratorSource.Comments]:
              BranchIdentityAvailability.Complete,
            [SessionCollaboratorSource.MetadataEdits]:
              BranchIdentityAvailability.Complete,
          },
        },
      })),
    };
  }
  if (artifactType !== CollaboratorArtifactType.Branch) {
    return {
      results: artifactIds.map((artifactId) => ({
        artifactId,
        artifactType,
        commentCount: 1,
        collaborators: {
          availability: BranchIdentityAvailability.Complete,
          people,
          sources: directSources,
        },
      })),
    };
  }
  return {
    results: artifactIds.map((artifactId, index) => ({
      artifactId,
      artifactType,
      collaborators: {
        availability: BranchIdentityAvailability.Incomplete,
        people: people.slice(
          index % people.length,
          (index % people.length) + 1
        ),
        sources: {
          ...directSources,
          [BranchCollaboratorSource.PullRequestAuthors]:
            BranchIdentityAvailability.Complete,
          [BranchCollaboratorSource.Pushes]:
            BranchIdentityAvailability.Incomplete,
          [BranchCollaboratorSource.PullRequestComments]:
            BranchIdentityAvailability.Incomplete,
          [BranchCollaboratorSource.BranchComments]:
            BranchIdentityAvailability.Complete,
          [BranchCollaboratorSource.SessionComments]:
            BranchIdentityAvailability.Complete,
        },
      },
    })),
  };
}

const directSources = {
  [DirectCollaboratorSource.Creator]: BranchIdentityAvailability.Complete,
  [DirectCollaboratorSource.Interactions]: BranchIdentityAvailability.Complete,
  [DirectCollaboratorSource.Comments]: BranchIdentityAvailability.Complete,
};
