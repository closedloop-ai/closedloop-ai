import { describe, expect, it } from "vitest";
import { ArtifactType } from "../artifact.ts";
import {
  ARTIFACT_COLLABORATOR_BATCH_MAX_IDS,
  artifactCollaboratorBatchQuerySchema,
  CollaboratorArtifactType,
  DirectCollaboratorSource,
  normalizeArtifactCollaboratorBatchResponse,
  SessionCollaboratorSource,
  unavailableArtifactCollaboratorBatchResponse,
  unavailableArtifactCollaborators,
} from "../artifact-collaborators.ts";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
  BranchPersonProvider,
  projectArtifactPeople,
} from "../branch-identity.ts";

const ARTIFACT_ID = "55555555-5555-4555-8555-555555555551";

describe("artifactCollaboratorBatchQuerySchema", () => {
  it("accepts one artifact type and a bounded page of IDs", () => {
    expect(
      artifactCollaboratorBatchQuerySchema.parse({
        artifactType: CollaboratorArtifactType.Session,
        artifactIds: [ARTIFACT_ID],
      })
    ).toEqual({
      artifactType: ArtifactType.Session,
      artifactIds: [ARTIFACT_ID],
    });
    expect(
      artifactCollaboratorBatchQuerySchema.parse({
        artifactType: CollaboratorArtifactType.Session,
        artifactIds: ARTIFACT_ID,
      }).artifactIds
    ).toEqual([ARTIFACT_ID]);
  });

  it("rejects an unsupported artifact type, malformed IDs, and an empty page", () => {
    for (const input of [
      { artifactType: "unsupported", artifactIds: [ARTIFACT_ID] },
      { artifactType: ArtifactType.Branch, artifactIds: ["not-a-uuid"] },
      { artifactType: ArtifactType.Session, artifactIds: [] },
      {
        artifactType: ArtifactType.Session,
        artifactIds: [ARTIFACT_ID],
        organizationId: "client-supplied-org",
      },
    ]) {
      expect(
        artifactCollaboratorBatchQuerySchema.safeParse(input).success
      ).toBe(false);
    }
  });

  it("rejects more IDs than the contract cap", () => {
    expect(
      artifactCollaboratorBatchQuerySchema.safeParse({
        artifactType: ArtifactType.Branch,
        artifactIds: Array.from(
          { length: ARTIFACT_COLLABORATOR_BATCH_MAX_IDS + 1 },
          () => ARTIFACT_ID
        ),
      }).success
    ).toBe(false);
  });
});

describe("Session people projection", () => {
  it("uses the shared stable-identity reducer with Session source availability", () => {
    const result = projectArtifactPeople(
      [
        {
          person: {
            provider: BranchPersonProvider.ClosedLoop,
            id: "user-1",
            userId: "user-1",
          },
        },
      ],
      {
        [SessionCollaboratorSource.Owner]: BranchIdentityAvailability.Complete,
        [SessionCollaboratorSource.Comments]:
          BranchIdentityAvailability.Incomplete,
        [SessionCollaboratorSource.MetadataEdits]:
          BranchIdentityAvailability.Complete,
      }
    );

    expect(result.people.map((person) => person.id)).toEqual(["user-1"]);
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
    expect(result.sources[SessionCollaboratorSource.Comments]).toBe(
      BranchIdentityAvailability.Incomplete
    );
  });
});

describe("unavailableArtifactCollaborators", () => {
  it("returns every Session source unavailable in Local mode", () => {
    expect(
      unavailableArtifactCollaborators(CollaboratorArtifactType.Session)
    ).toEqual({
      availability: BranchIdentityAvailability.Unavailable,
      people: [],
      sources: {
        ...unavailableArtifactCollaborators(ArtifactType.Document).sources,
        [SessionCollaboratorSource.Owner]:
          BranchIdentityAvailability.Unavailable,
        [SessionCollaboratorSource.Comments]:
          BranchIdentityAvailability.Unavailable,
        [SessionCollaboratorSource.MetadataEdits]:
          BranchIdentityAvailability.Unavailable,
      },
    });
  });

  it("returns every Branch source unavailable in Local mode", () => {
    expect(
      unavailableArtifactCollaborators(CollaboratorArtifactType.Branch)
    ).toEqual({
      availability: BranchIdentityAvailability.Unavailable,
      people: [],
      sources: {
        ...unavailableArtifactCollaborators(ArtifactType.Document).sources,
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
      },
    });
  });

  it("returns one unavailable entry per distinct Local artifact ID", () => {
    const result = unavailableArtifactCollaboratorBatchResponse(
      CollaboratorArtifactType.Session,
      [ARTIFACT_ID, ARTIFACT_ID]
    );

    expect(result.results).toEqual([
      {
        artifactId: ARTIFACT_ID,
        artifactType: CollaboratorArtifactType.Session,
        collaborators: unavailableArtifactCollaborators(
          CollaboratorArtifactType.Session
        ),
      },
    ]);
  });
});

describe("normalizeArtifactCollaboratorBatchResponse", () => {
  it("preserves a proven complete-empty Session", () => {
    const result = normalizeArtifactCollaboratorBatchResponse(
      {
        results: [
          {
            artifactId: ARTIFACT_ID,
            artifactType: CollaboratorArtifactType.Session,
            collaborators: {
              availability: BranchIdentityAvailability.Complete,
              people: [],
              sources: {
                [DirectCollaboratorSource.Creator]:
                  BranchIdentityAvailability.Complete,
                [DirectCollaboratorSource.Interactions]:
                  BranchIdentityAvailability.Complete,
                [DirectCollaboratorSource.Comments]:
                  BranchIdentityAvailability.Complete,
                [SessionCollaboratorSource.Owner]:
                  BranchIdentityAvailability.Complete,
                [SessionCollaboratorSource.Comments]:
                  BranchIdentityAvailability.Complete,
                [SessionCollaboratorSource.MetadataEdits]:
                  BranchIdentityAvailability.Complete,
              },
            },
          },
        ],
      },
      CollaboratorArtifactType.Session
    );

    expect(result.results[0]?.collaborators).toEqual({
      availability: BranchIdentityAvailability.Complete,
      people: [],
      sources: {
        [DirectCollaboratorSource.Creator]: BranchIdentityAvailability.Complete,
        [DirectCollaboratorSource.Interactions]:
          BranchIdentityAvailability.Complete,
        [DirectCollaboratorSource.Comments]:
          BranchIdentityAvailability.Complete,
        [SessionCollaboratorSource.Owner]: BranchIdentityAvailability.Complete,
        [SessionCollaboratorSource.Comments]:
          BranchIdentityAvailability.Complete,
        [SessionCollaboratorSource.MetadataEdits]:
          BranchIdentityAvailability.Complete,
      },
    });
  });

  it("keeps a known legacy person while missing availability stays incomplete", () => {
    const result = normalizeArtifactCollaboratorBatchResponse(
      {
        results: [
          {
            artifactId: ARTIFACT_ID,
            artifactType: CollaboratorArtifactType.Session,
            collaborators: {
              people: [
                {
                  provider: BranchPersonProvider.ClosedLoop,
                  id: "user-1",
                  userId: "user-1",
                  avatarUrl: null,
                },
              ],
            },
          },
        ],
      },
      CollaboratorArtifactType.Session
    );

    expect(result.results[0]?.collaborators.people).toEqual([
      {
        provider: BranchPersonProvider.ClosedLoop,
        id: "user-1",
        userId: "user-1",
      },
    ]);
    expect(result.results[0]?.collaborators.availability).toBe(
      BranchIdentityAvailability.Incomplete
    );
    expect(result.results[0]?.collaborators.sources).toEqual(
      unavailableArtifactCollaborators(CollaboratorArtifactType.Session).sources
    );
  });

  it("does not promote unknown Branch source keys or values to complete", () => {
    const sources = {
      ...unavailableArtifactCollaborators(CollaboratorArtifactType.Branch)
        .sources,
      [BranchCollaboratorSource.PullRequestAuthors]:
        BranchIdentityAvailability.Complete,
      [BranchCollaboratorSource.Pushes]: "future_state",
      future_source: BranchIdentityAvailability.Complete,
    };
    const result = normalizeArtifactCollaboratorBatchResponse(
      {
        results: [
          {
            artifactId: ARTIFACT_ID,
            artifactType: CollaboratorArtifactType.Branch,
            collaborators: {
              availability: BranchIdentityAvailability.Complete,
              people: [],
              sources,
            },
          },
        ],
      },
      CollaboratorArtifactType.Branch
    );

    expect(result.results[0]?.collaborators.availability).toBe(
      BranchIdentityAvailability.Incomplete
    );
    const entry = result.results[0];
    if (entry?.artifactType !== CollaboratorArtifactType.Branch) {
      throw new Error("expected Branch collaborators");
    }
    expect(entry.collaborators.sources[BranchCollaboratorSource.Pushes]).toBe(
      BranchIdentityAvailability.Incomplete
    );
  });

  it("refuses an error envelope and a mismatched artifact type", () => {
    expect(() =>
      normalizeArtifactCollaboratorBatchResponse(
        { success: false, error: "unavailable" },
        CollaboratorArtifactType.Session
      )
    ).toThrow();
    expect(() =>
      normalizeArtifactCollaboratorBatchResponse(
        {
          results: [
            {
              artifactId: ARTIFACT_ID,
              artifactType: CollaboratorArtifactType.Branch,
              collaborators: { people: [], sources: {} },
            },
          ],
        },
        CollaboratorArtifactType.Session
      )
    ).toThrow("Invalid collaborator batch identity");
  });
});

describe("direct artifact comment counts", () => {
  it.each([ArtifactType.Document, ArtifactType.Deployment])(
    "accepts %s and preserves measured or missing counts",
    (artifactType) => {
      const entry = {
        artifactId: ARTIFACT_ID,
        artifactType,
        collaborators: unavailableArtifactCollaborators(artifactType),
      };
      expect(
        normalizeArtifactCollaboratorBatchResponse(
          { results: [{ ...entry, commentCount: 7 }] },
          artifactType
        ).results[0].commentCount
      ).toBe(7);
      expect(
        normalizeArtifactCollaboratorBatchResponse(
          { results: [entry] },
          artifactType
        ).results[0]
      ).not.toHaveProperty("commentCount");
    }
  );
  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    null,
  ])("rejects impossible wire comment count %s", (commentCount) => {
    expect(() =>
      normalizeArtifactCollaboratorBatchResponse(
        {
          results: [
            {
              artifactId: ARTIFACT_ID,
              artifactType: ArtifactType.Document,
              commentCount,
              collaborators: unavailableArtifactCollaborators(
                ArtifactType.Document
              ),
            },
          ],
        },
        ArtifactType.Document
      )
    ).toThrow();
  });
});
