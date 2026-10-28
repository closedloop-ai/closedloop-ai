import { randomUUID } from "node:crypto";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { relinkPullRequestBranchInTransaction } from "@/app/branches/pull-request-branch-relink";
import { createTestOrganization } from "../utils/db-helpers";

const REPOSITORY_FULL_NAME = "closedloop-ai/closedloop-ai";
const createdOrganizationIds: string[] = [];

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-6980 Branch activity relink aggregates",
  () => {
    afterEach(async () => {
      for (const organizationId of createdOrganizationIds.splice(0)) {
        await withDb(async (db) => {
          await db.artifact.deleteMany({ where: { organizationId } });
          await db.organization.delete({ where: { id: organizationId } });
        });
      }
    });

    it("lowers the source scalar after its latest PR atom moves", async () => {
      const organizationId = await createTestOrganization();
      createdOrganizationIds.push(organizationId);
      const sourceBranchArtifactId = await seedBranch(organizationId, "source");
      const targetBranchArtifactId = await seedBranch(organizationId, "target");
      const pullRequest = await withDb((db) =>
        db.pullRequestDetail.create({
          data: {
            branchArtifactId: sourceBranchArtifactId,
            organizationId,
            repositoryFullName: REPOSITORY_FULL_NAME,
            githubId: `iss6980-pr-${randomUUID()}`,
            number: 6980,
          },
          select: { id: true },
        })
      );
      const retainedAt = new Date("2026-08-17T08:00:00.000Z");
      const movedAt = new Date("2026-08-17T09:00:00.000Z");
      await withDb(async (db) => {
        await db.branchActivityAtom.createMany({
          data: [
            {
              version: BranchActivityAtomVersion.V1,
              organizationId,
              branchArtifactId: sourceBranchArtifactId,
              source: BranchActivitySource.GitHead,
              sourceEventId: "retained-source-activity",
              occurredAt: retainedAt,
              attributionKind: BranchActivityAttributionKind.Branch,
              completeness: BranchActivityEvidenceCompleteness.Complete,
              createdAt: retainedAt,
            },
            {
              version: BranchActivityAtomVersion.V1,
              organizationId,
              branchArtifactId: sourceBranchArtifactId,
              source: BranchActivitySource.PullRequestLifecycle,
              sourceEventId: "moved-pr-activity",
              occurredAt: movedAt,
              attributionKind: BranchActivityAttributionKind.PullRequest,
              pullRequestDetailId: pullRequest.id,
              completeness: BranchActivityEvidenceCompleteness.Complete,
              createdAt: movedAt,
            },
          ],
        });
        await db.branchDetail.update({
          where: { artifactId: sourceBranchArtifactId },
          data: { lastActivityAt: movedAt },
          select: { artifactId: true },
        });
      });

      await expect(
        withDb.tx((tx) =>
          relinkPullRequestBranchInTransaction(tx, {
            organizationId,
            pullRequestDetailId: pullRequest.id,
            branchArtifactId: targetBranchArtifactId,
            repositoryFullName: REPOSITORY_FULL_NAME,
            pullRequestNumber: 6980,
          })
        )
      ).resolves.toBe(true);

      const [source, target, movedAtom] = await withDb((db) =>
        Promise.all([
          db.branchDetail.findUniqueOrThrow({
            where: { artifactId: sourceBranchArtifactId },
            select: { lastActivityAt: true },
          }),
          db.branchDetail.findUniqueOrThrow({
            where: { artifactId: targetBranchArtifactId },
            select: { lastActivityAt: true },
          }),
          db.branchActivityAtom.findFirstOrThrow({
            where: { organizationId, sourceEventId: "moved-pr-activity" },
            select: { branchArtifactId: true },
          }),
        ])
      );
      expect(source.lastActivityAt).toEqual(retainedAt);
      expect(target.lastActivityAt).toEqual(movedAt);
      expect(movedAtom.branchArtifactId).toBe(targetBranchArtifactId);
    }, 20_000);
  }
);

async function seedBranch(
  organizationId: string,
  label: string
): Promise<string> {
  return (
    await withDb((db) =>
      db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.Branch,
          name: `ISS-6980 ${label}`,
          status: GitHubPRState.Open,
          branch: {
            create: {
              organizationId,
              repositoryFullName: REPOSITORY_FULL_NAME,
              branchName: `feature/${label}-${randomUUID()}`,
            },
          },
        },
        select: { id: true },
      })
    )
  ).id;
}
