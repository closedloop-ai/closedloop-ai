import { BranchStatus } from "@repo/api/src/types/branch";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { BranchPushContributionSource } from "@repo/api/src/types/branch-push-contribution";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { ArtifactType, ExternalCommentProvider, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import {
  BranchPushContributionWriteResult,
  invalidateBranchPushCoverageAfterWebhook,
  recordBranchPushContribution,
} from "./branch-push-contribution-service";

const tracker = createCommittedTestOrganizationTracker();
const repositoryFullName = "closedloop-ai/closedloop-ai";
const refName = "feature/collaborators";
const beforeSha = "a".repeat(40);
const afterSha = "b".repeat(40);

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-10992 Branch push contribution",
  () => {
    afterEach(() => tracker.cleanup());

    it("persists one reported account for one org/repository/Branch/ref and deduplicates replay", async () => {
      const organizationId = await tracker.create();
      const foreignOrganizationId = await tracker.create();
      const branchArtifactId = await seedBranch(organizationId);
      const foreignBranchArtifactId = await seedBranch(foreignOrganizationId);
      const input = {
        organizationId,
        branchArtifactId,
        repositoryFullName,
        refName,
        beforeSha,
        afterSha,
        source: BranchPushContributionSource.GraphqlPush,
        sourceEventId: "delivery-1",
        providerUserId: "123",
        actorType: GitHubActorType.User,
        newCommitCount: 1,
        observedAt: new Date("2026-09-30T00:00:00.000Z"),
      } as const;

      await expect(recordBranchPushContribution(input)).resolves.toBe(
        BranchPushContributionWriteResult.Recorded
      );
      await expect(recordBranchPushContribution(input)).resolves.toBe(
        BranchPushContributionWriteResult.Duplicate
      );
      await expect(
        recordBranchPushContribution({ ...input, refName: "other-branch" })
      ).resolves.toBe(BranchPushContributionWriteResult.Ignored);
      await expect(
        recordBranchPushContribution({
          ...input,
          organizationId: foreignOrganizationId,
          sourceEventId: "foreign-delivery",
        })
      ).resolves.toBe(BranchPushContributionWriteResult.Ignored);
      await expect(
        recordBranchPushContribution({
          ...input,
          branchArtifactId: foreignBranchArtifactId,
          actorType: GitHubActorType.Bot,
          sourceEventId: "bot-delivery",
        })
      ).resolves.toBe(BranchPushContributionWriteResult.Ignored);

      const rows = await withDb((db) =>
        db.branchPushContribution.findMany({
          where: { organizationId },
          select: {
            branchArtifactId: true,
            repositoryFullName: true,
            refName: true,
            providerUserId: true,
            actorType: true,
            sourceEventId: true,
          },
        })
      );
      expect(rows).toEqual([
        {
          branchArtifactId,
          repositoryFullName,
          refName,
          providerUserId: "123",
          actorType: GitHubActorType.User,
          sourceEventId: "delivery-1",
        },
      ]);
      await expect(
        withDb((db) =>
          db.externalCommentAuthor.findUnique({
            where: {
              organizationId_provider_providerUserId: {
                organizationId,
                provider: ExternalCommentProvider.GITHUB,
                providerUserId: "123",
              },
            },
            select: {
              providerUserId: true,
              user: { select: { active: true } },
            },
          })
        )
      ).resolves.toEqual({
        providerUserId: "123",
        user: { active: false },
      });
      await expect(
        withDb((db) =>
          db.branchPushContribution.count({
            where: { organizationId: foreignOrganizationId },
          })
        )
      ).resolves.toBe(0);
    });

    it("reopens only the owned Branch coverage after a webhook", async () => {
      const organizationId = await tracker.create();
      const foreignOrganizationId = await tracker.create();
      const branchArtifactId = await seedBranch(organizationId);
      const lastAttemptAt = new Date("2026-09-30T00:00:00.000Z");
      await withDb((db) =>
        db.branchDetail.updateMany({
          where: { organizationId, artifactId: branchArtifactId },
          data: {
            pushCoverageAvailability: BranchIdentityAvailability.Complete,
            pushCoverageLastAttemptAt: lastAttemptAt,
          },
        })
      );

      await invalidateBranchPushCoverageAfterWebhook({
        organizationId: foreignOrganizationId,
        branchArtifactId,
      });
      await expect(
        withDb((db) =>
          db.branchDetail.findUnique({
            where: { artifactId: branchArtifactId },
            select: {
              pushCoverageAvailability: true,
              pushCoverageLastAttemptAt: true,
            },
          })
        )
      ).resolves.toEqual({
        pushCoverageAvailability: BranchIdentityAvailability.Complete,
        pushCoverageLastAttemptAt: lastAttemptAt,
      });

      await invalidateBranchPushCoverageAfterWebhook({
        organizationId,
        branchArtifactId,
      });
      await expect(
        withDb((db) =>
          db.branchDetail.findUnique({
            where: { artifactId: branchArtifactId },
            select: {
              pushCoverageAvailability: true,
              pushCoverageLastAttemptAt: true,
            },
          })
        )
      ).resolves.toEqual({
        pushCoverageAvailability: BranchIdentityAvailability.Incomplete,
        pushCoverageLastAttemptAt: null,
      });
    });
  }
);

async function seedBranch(organizationId: string): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: refName,
        status: BranchStatus.Open,
        branch: {
          create: { organizationId, repositoryFullName, branchName: refName },
        },
      },
      select: { id: true },
    })
  );
  return artifact.id;
}
