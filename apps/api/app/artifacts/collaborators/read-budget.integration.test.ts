import { randomUUID } from "node:crypto";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import {
  ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE,
  CollaboratorArtifactType,
  unavailableArtifactCollaboratorBatchResponse,
} from "@repo/api/src/types/artifact-collaborators";
import { BranchStatus } from "@repo/api/src/types/branch";
import { BranchPersonProvider } from "@repo/api/src/types/branch-identity";
import { BranchPushContributionSource } from "@repo/api/src/types/branch-push-contribution";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { chunksOf } from "@/lib/chunks-of";
import { COLLABORATOR_READ_MAX_RESPONSE_BYTES } from "./read-budget";
import { artifactCollaboratorsService } from "./service";

const tracker = createCommittedTestOrganizationTracker();

describe.skipIf(!keys().DATABASE_URL)("collaborator read admission", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await tracker.cleanup();
  });

  it("bounds 100 Branch IDs across author and pusher lanes without losing either smaller cohort", async () => {
    const organizationId = await tracker.create();
    const artifactIds = Array.from({ length: 100 }, () => randomUUID());
    await withDb(async (db) => {
      await db.artifact.createMany({
        data: artifactIds.map((id) => ({
          id,
          organizationId,
          type: ArtifactType.Branch,
          name: `budget-${id}`,
          status: BranchStatus.Open,
        })),
      });
      await db.branchDetail.createMany({
        data: artifactIds.map((artifactId) => ({
          artifactId,
          organizationId,
          branchName: `budget-${artifactId}`,
          repositoryFullName: "acme/app",
        })),
      });
    });
    const rows = artifactIds.flatMap((branchArtifactId, branchIndex) =>
      Array.from({ length: 250 }, (_, index) => ({
        branchArtifactId,
        branchIndex,
        index,
      }))
    );
    for (const chunk of chunksOf(rows, 1000)) {
      await withDb((db) =>
        db.pullRequestDetail.createMany({
          data: chunk.map(({ branchArtifactId, branchIndex, index }) => ({
            organizationId,
            branchArtifactId,
            repositoryFullName: "acme/app",
            number: branchIndex * 250 + index + 1,
            authorProviderUserId: "123",
            authorActorType: GitHubActorType.User,
            authorLogin: "reported-author",
          })),
        })
      );
      await withDb((db) =>
        db.branchPushContribution.createMany({
          data: chunk.map(({ branchArtifactId, index }) => ({
            organizationId,
            branchArtifactId,
            repositoryFullName: "acme/app",
            refName: `budget-${branchArtifactId}`,
            source: BranchPushContributionSource.GraphqlPush,
            sourceEventId: `event-${index}`,
            beforeSha: "a".repeat(40),
            afterSha: "b".repeat(40),
            providerUserId: "456",
            actorType: GitHubActorType.User,
          })),
        })
      );
    }
    const materialize = vi.spyOn(artifactCollaboratorsService, "readBatch");
    await expect(
      artifactCollaboratorsService.readBoundedBatch(organizationId, {
        artifactType: CollaboratorArtifactType.Branch,
        artifactIds,
      })
    ).resolves.toEqual({
      ok: false,
      error: ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE,
    });
    expect(materialize).not.toHaveBeenCalled();
    const returnedIds: string[] = [];
    for (const ids of [artifactIds.slice(0, 50), artifactIds.slice(50)]) {
      const result = await artifactCollaboratorsService.readBoundedBatch(
        organizationId,
        {
          artifactType: CollaboratorArtifactType.Branch,
          artifactIds: ids,
        }
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Smaller Branch cohort did not fit");
      }
      returnedIds.push(
        ...result.value.results.map((entry) => entry.artifactId)
      );
      for (const entry of result.value.results) {
        expect(
          entry.collaborators.people.map((person) => person.id).sort()
        ).toEqual(["123", "456"]);
      }
    }
    expect(returnedIds).toEqual(artifactIds);
  });

  it("rejects an oversized serialized response whole rather than publishing a partial result", async () => {
    const organizationId = await tracker.create();
    const user = await createTestUser(organizationId);
    const artifactId = await createTestSessionDetail({
      organizationId,
      userId: user.id,
      label: "response-budget",
    });
    const response = unavailableArtifactCollaboratorBatchResponse(
      CollaboratorArtifactType.Session,
      [artifactId]
    );
    const entry = response.results[0];
    if (!entry) {
      throw new Error("Session response fixture was not created");
    }
    entry.collaborators.people.push({
      provider: BranchPersonProvider.ClosedLoop,
      id: user.id,
      userId: user.id,
      displayName: "x".repeat(COLLABORATOR_READ_MAX_RESPONSE_BYTES),
    });
    const materialize = vi
      .spyOn(artifactCollaboratorsService, "readBatch")
      .mockResolvedValue(response);
    await expect(
      artifactCollaboratorsService.readBoundedBatch(organizationId, {
        artifactType: CollaboratorArtifactType.Session,
        artifactIds: [artifactId],
      })
    ).resolves.toEqual({
      ok: false,
      error: ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE,
    });
    expect(materialize).toHaveBeenCalledWith(organizationId, {
      artifactType: CollaboratorArtifactType.Session,
      artifactIds: [artifactId],
    });
  });

  it("rejects a saturated cohort before profile reads and admits both smaller halves", async () => {
    const organizationId = await tracker.create();
    const user = await createTestUser(organizationId);
    const artifactIds: string[] = [];
    for (let index = 0; index < 50; index++) {
      const artifactId = await createTestSessionDetail({
        organizationId,
        userId: user.id,
        label: `budget-${index}`,
        metadataActivityCoverageStartedAt: new Date(),
      });
      artifactIds.push(artifactId);
      await withDb((db) =>
        db.artifactActivityEvent.createMany({
          data: Array.from({ length: 1000 }, () => ({
            organizationId,
            artifactId,
            actorType: ArtifactActivityActorType.User,
            actorId: user.id,
            action: ArtifactActivityAction.StatusChange,
            after: {},
          })),
        })
      );
    }
    const materialize = vi.spyOn(artifactCollaboratorsService, "readBatch");
    await expect(
      artifactCollaboratorsService.readBoundedBatch(organizationId, {
        artifactType: CollaboratorArtifactType.Session,
        artifactIds,
      })
    ).resolves.toEqual({
      ok: false,
      error: ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE,
    });
    expect(materialize).not.toHaveBeenCalled();

    const returnedIds: string[] = [];
    for (const ids of [artifactIds.slice(0, 25), artifactIds.slice(25)]) {
      const result = await artifactCollaboratorsService.readBoundedBatch(
        organizationId,
        { artifactType: CollaboratorArtifactType.Session, artifactIds: ids }
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Smaller cohort did not fit the budget");
      }
      returnedIds.push(
        ...result.value.results.map((entry) => entry.artifactId)
      );
      for (const entry of result.value.results) {
        expect(
          entry.collaborators.people.map((person) => person.userId)
        ).toEqual([user.id]);
      }
    }
    expect(returnedIds).toEqual(artifactIds);
  });

  // ISS-11589 ruling (2026-10-12): "We want deleted branches, in the list and in
  // the metrics card. Active branches is the only exception."
  it("serves a soft-deleted Branch and omits missing-detail and foreign ones through the public read", async () => {
    const organizationId = await tracker.create();
    const foreignOrganizationId = await tracker.create();
    const ids = await withDb(async (db) => {
      const live = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.Branch,
          name: "budget-live",
          status: BranchStatus.Open,
          branch: {
            create: {
              organizationId,
              repositoryFullName: "acme/app",
              branchName: "live",
            },
          },
        },
      });
      const deleted = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.Branch,
          name: "budget-deleted",
          status: BranchStatus.Open,
          branch: {
            create: {
              organizationId,
              repositoryFullName: "acme/app",
              branchName: "deleted",
              deletedAt: new Date(),
            },
          },
        },
      });
      const missing = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.Branch,
          name: "no-detail",
          status: BranchStatus.Open,
        },
      });
      const foreign = await db.artifact.create({
        data: {
          organizationId: foreignOrganizationId,
          type: ArtifactType.Branch,
          name: "foreign",
          status: BranchStatus.Open,
          branch: {
            create: {
              organizationId: foreignOrganizationId,
              repositoryFullName: "acme/app",
              branchName: "foreign",
            },
          },
        },
      });
      return {
        live: live.id,
        deleted: deleted.id,
        missing: missing.id,
        foreign: foreign.id,
      };
    });
    const result = await artifactCollaboratorsService.readBoundedBatch(
      organizationId,
      {
        artifactType: CollaboratorArtifactType.Branch,
        artifactIds: Object.values(ids),
      }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Small Branch cohort did not fit the budget");
    }
    expect(result.value.results.map((entry) => entry.artifactId)).toEqual([
      ids.live,
      ids.deleted,
    ]);
  });
});
