import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  DirectCollaboratorSource,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: vi.fn(),
}));
vi.mock(
  "@/app/branches/branch-read-service/identity-attribution",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    resolveBranchIdentities: vi.fn(),
  })
);
vi.mock(
  "@/app/branches/branch-read-service/batch-session-link-evidence",
  () => ({ readBatchSessionLinkEvidence: vi.fn() })
);

import { readBatchSessionLinkEvidence } from "@/app/branches/branch-read-service/batch-session-link-evidence";
import { resolveBranchIdentities } from "@/app/branches/branch-read-service/identity-attribution";
import { COMMENT_EVIDENCE_LIMIT } from "@/app/branches/branch-read-service/page-comment-evidence";
import { artifactCollaboratorsService } from "./service";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_BRANCH_ID = "22222222-2222-4222-8222-222222222222";
const LATER_BRANCH_ID = "33333333-3333-4333-8333-333333333333";
const LATER_USER_ID = "55555555-5555-4555-8555-555555555555";
const branchIds = [FIRST_BRANCH_ID, LATER_BRANCH_ID];
const db = {
  $queryRaw: vi.fn(),
  artifact: { findMany: vi.fn() },
  artifactLink: { findMany: vi.fn() },
};
const ownersByBranch = new Map(
  branchIds.map((id) => [
    id,
    {
      observedUserId: null,
      observedAvailability: BranchIdentityAvailability.Complete,
    },
  ])
);
const commentsByBranch = new Map([
  [LATER_BRANCH_ID, [{ branchId: LATER_BRANCH_ID, authorId: LATER_USER_ID }]],
]);

describe("artifact Collaborators bounded persisted-link evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withDb).mockImplementation(
      async (read) => await read(db as never)
    );
    db.$queryRaw.mockResolvedValue([]);
    db.artifact.findMany.mockResolvedValue(
      branchIds.map((id) => ({
        id,
        branch: { firstPushedAt: null },
        pullRequestDetails: [],
      }))
    );
    vi.mocked(readBatchSessionLinkEvidence).mockResolvedValue({
      ownersByBranch,
      commentsByBranch,
    });
    mockIdentities(identitiesFor(branchIds));
  });

  it("passes later-Branch comments and canonical Owner decisions without materializing link history", async () => {
    const result = await artifactCollaboratorsService.readBatch(
      ORGANIZATION_ID,
      { artifactType: ArtifactType.Branch, artifactIds: branchIds }
    );
    expect(result.results.map((entry) => entry.artifactId)).toEqual(branchIds);
    expect(readBatchSessionLinkEvidence).toHaveBeenCalledWith(
      db,
      ORGANIZATION_ID,
      branchIds,
      COMMENT_EVIDENCE_LIMIT
    );
    expect(resolveBranchIdentities).toHaveBeenCalledWith(
      db,
      ORGANIZATION_ID,
      branchIds.map((branchId) => ({
        branchId,
        firstPushedAt: null,
        associatedPullRequestCount: 0,
        pullRequestAuthorLogins: [],
      })),
      [],
      expect.objectContaining({
        ownerEvidenceByBranch: ownersByBranch,
        sessionCommentRowsByBranch: commentsByBranch,
        directParticipationOut: expect.any(Map),
      })
    );
    expect(db.artifactLink.findMany).not.toHaveBeenCalled();
  });

  it("returns the Branch identity projection, which already holds direct people, without re-merging them", async () => {
    const identityCollaborators = {
      ...unavailableArtifactCollaborators(ArtifactType.Branch),
      availability: BranchIdentityAvailability.Incomplete,
      sources: {
        ...unavailableArtifactCollaborators(ArtifactType.Branch).sources,
        [DirectCollaboratorSource.Creator]:
          BranchIdentityAvailability.Incomplete,
      },
    };
    mockIdentities(
      new Map([
        [
          FIRST_BRANCH_ID,
          {
            ownerIdentity: {
              availability: BranchIdentityAvailability.Complete,
              person: null,
            },
            collaborators: identityCollaborators,
          },
        ],
      ])
    );

    const result = await artifactCollaboratorsService.readBatch(
      ORGANIZATION_ID,
      { artifactType: ArtifactType.Branch, artifactIds: [FIRST_BRANCH_ID] }
    );

    expect(result.results).toEqual([
      {
        artifactId: FIRST_BRANCH_ID,
        artifactType: ArtifactType.Branch,
        commentCount: DIRECT_COMMENT_COUNT,
        collaborators: identityCollaborators,
      },
    ]);
  });

  it("takes Branch direct participation from the identity pass instead of reading it separately", async () => {
    await artifactCollaboratorsService.readBatch(ORGANIZATION_ID, {
      artifactType: ArtifactType.Branch,
      artifactIds: branchIds,
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("reads a deleted Branch's Collaborators: deletion decides only whether it is active (ISS-11589)", async () => {
    await artifactCollaboratorsService.readBatch(ORGANIZATION_ID, {
      artifactType: ArtifactType.Branch,
      artifactIds: branchIds,
    });
    expect(db.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ branch: { isNot: null } }),
      })
    );
  });

  it("rejects a failed source window instead of returning partial people", async () => {
    vi.mocked(readBatchSessionLinkEvidence).mockRejectedValueOnce(
      new Error("link evidence unavailable")
    );
    await expect(
      artifactCollaboratorsService.readBatch(ORGANIZATION_ID, {
        artifactType: ArtifactType.Branch,
        artifactIds: branchIds,
      })
    ).rejects.toThrow("link evidence unavailable");
    expect(resolveBranchIdentities).not.toHaveBeenCalled();
  });
});

const DIRECT_COMMENT_COUNT = 2;

function identitiesFor(ids: readonly string[]) {
  return new Map(
    ids.map((branchId) => [
      branchId,
      {
        ownerIdentity: {
          availability: BranchIdentityAvailability.Complete,
          person: null,
        },
        collaborators: unavailableArtifactCollaborators(ArtifactType.Branch),
      },
    ])
  );
}

/** The identity pass fills `directParticipationOut` for every Branch it resolves. */
function mockIdentities(
  identities: Awaited<ReturnType<typeof resolveBranchIdentities>>
) {
  vi.mocked(resolveBranchIdentities).mockImplementation(
    async (_db, _organizationId, branches, _links, options) => {
      for (const { branchId } of branches) {
        options?.directParticipationOut?.set(branchId, {
          artifactId: branchId,
          artifactType: ArtifactType.Branch,
          commentCount: DIRECT_COMMENT_COUNT,
          collaborators: unavailableArtifactCollaborators(
            ArtifactType.Document
          ),
        });
      }
      return await Promise.resolve(identities);
    }
  );
}
