import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import { BranchDataState, BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { branchReadService } from "@/app/branches/branch-read-service";
import { branchService } from "@/app/branches/branch-service";
import {
  GitHubServerSyncReason,
  GitHubServerSyncStatus,
  githubServerSyncService,
} from "@/app/integrations/github/sync-service";
import { linkValidSessionToBranch } from "../utils/db-helpers";
import {
  createCommittedBranchTestRunner,
  seedBranchTestContext,
  stampBranchSessionPushes,
} from "./branch-artifact-test-helpers";

const hasDatabase = !!keys().DATABASE_URL;
const runCommittedBranchTest = createCommittedBranchTestRunner(
  seedBranchTestContext,
  () => Promise.resolve()
);

describe.skipIf(!hasDatabase)(
  "branch pull request repository ownership",
  () => {
    it("ignores wrong-repository current PR rows but surfaces an owned control", async () => {
      await runCommittedBranchTest(async (ctx) => {
        const branchName = "FEA-2527-wrong-repo-pr";
        const sidecarFullName = `${ctx.repositoryFullName}-wrong-pr`;
        const sidecarRepository = await withDb((db) =>
          db.gitHubInstallationRepository.create({
            data: {
              installationId: ctx.installationRecordId,
              githubRepoId: `${ctx.githubRepoId}-wrong-pr`,
              fullName: sidecarFullName,
              name: sidecarFullName.split("/")[1] ?? "wrong-pr",
              owner: sidecarFullName.split("/")[0] ?? "owner",
              private: false,
            },
            select: { id: true },
          })
        );
        const localResult = await branchService.upsertBranchArtifact({
          organizationId: ctx.organizationId,
          repositoryId: ctx.repositoryId,
          repositoryFullName: ctx.repositoryFullName,
          branchName,
          defaultBranch: "main",
          projectId: ctx.projectId,
          baseBranch: "main",
          baseBranchSource: BranchBaseBranchSource.HarnessInput,
          headSha: "local-only-head-sha",
          headShaSource: BranchHeadShaSource.HarnessInput,
        });
        expect(localResult.ok).toBe(true);
        if (!localResult.ok) {
          throw new Error("Expected local branch materialization to succeed");
        }
        const sessionId = await linkValidSessionToBranch({
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          branchArtifactId: localResult.value.id,
          label: branchName,
        });
        await stampBranchSessionPushes(
          [localResult.value.id],
          new Date("2026-05-15T00:00:00Z")
        );
        const pullRequest = await withDb((db) =>
          db.pullRequestDetail.create({
            data: {
              organizationId: ctx.organizationId,
              branchArtifactId: localResult.value.id,
              repositoryId: sidecarRepository.id,
              githubId: `wrong-repo-current-pr-2527-${ctx.organizationId}`,
              number: 2527,
              title: "Foreign searchable PR",
              htmlUrl: `https://github.com/${sidecarFullName}/pull/2527`,
              prState: GitHubPRState.OPEN,
              isCurrent: true,
            },
            select: { id: true },
          })
        );

        await expect(
          branchReadService.getBranchDetail(
            ctx.organizationId,
            localResult.value.id
          )
        ).resolves.toMatchObject({
          id: localResult.value.id,
          dataState: BranchDataState.Ready,
          selectedPullRequest: null,
        });
        await expect(
          branchReadService.listBranches(ctx.organizationId, {
            limit: 50,
            offset: 0,
            repository: [ctx.repositoryFullName],
            search: "Foreign searchable PR",
            status: [BranchStatus.Open],
          })
        ).resolves.toMatchObject({ items: [], total: 0 });

        await withDb((db) =>
          db.pullRequestDetail.update({
            where: { id: pullRequest.id },
            data: { repositoryId: ctx.repositoryId },
          })
        );
        await expect(
          branchReadService.getBranchDetail(
            ctx.organizationId,
            localResult.value.id
          )
        ).resolves.toMatchObject({
          id: localResult.value.id,
          selectedPullRequest: expect.objectContaining({ number: 2527 }),
        });
        await expect(
          branchReadService.listBranches(ctx.organizationId, {
            limit: 50,
            offset: 0,
            repository: [ctx.repositoryFullName],
            search: "Foreign searchable PR",
            status: [BranchStatus.Open],
          })
        ).resolves.toMatchObject({
          items: [
            expect.objectContaining({
              id: localResult.value.id,
              sessionIds: [sessionId],
            }),
          ],
          total: 1,
        });
      });
    });

    // PR #6453 review: the unit mock proves the guard branch, but this suite
    // only exercised READS and the real-DB refresh case only ever had an owned
    // row. This drives the production query through Postgres: the tombstoned
    // user-OAuth lane spends a USER's token on `<branch repo>#<number>`, so a
    // canonical row whose repository disagrees with the branch's must be
    // refused before any credential or provider work — and before the relink.
    it("refuses a foreign canonical row in the tombstoned refresh path", async () => {
      await runCommittedBranchTest(async (ctx) => {
        const branchName = "ISS-8522-foreign-canonical-refresh";
        const sidecarFullName = `${ctx.repositoryFullName}-foreign-refresh`;
        const sidecarRepository = await withDb((db) =>
          db.gitHubInstallationRepository.create({
            data: {
              installationId: ctx.installationRecordId,
              githubRepoId: `${ctx.githubRepoId}-foreign-refresh`,
              fullName: sidecarFullName,
              name: sidecarFullName.split("/")[1] ?? "foreign-refresh",
              owner: sidecarFullName.split("/")[0] ?? "owner",
              private: false,
            },
            select: { id: true },
          })
        );
        const localResult = await branchService.upsertBranchArtifact({
          organizationId: ctx.organizationId,
          repositoryId: ctx.repositoryId,
          repositoryFullName: ctx.repositoryFullName,
          branchName,
          defaultBranch: "main",
          projectId: ctx.projectId,
          baseBranch: "main",
          baseBranchSource: BranchBaseBranchSource.HarnessInput,
          headSha: "foreign-canonical-head-sha",
          headShaSource: BranchHeadShaSource.HarnessInput,
        });
        expect(localResult.ok).toBe(true);
        if (!localResult.ok) {
          throw new Error("Expected local branch materialization to succeed");
        }
        const branchArtifactId = localResult.value.id;

        // Never promoted, so the pointer cannot be what selects this row: the
        // canonical resolution reaches it through the branch's owned set.
        const foreignPullRequest = await withDb((db) =>
          db.pullRequestDetail.create({
            data: {
              organizationId: ctx.organizationId,
              branchArtifactId,
              repositoryId: sidecarRepository.id,
              githubId: `foreign-canonical-8522-${ctx.organizationId}`,
              number: 8522,
              title: "Foreign canonical PR",
              htmlUrl: `https://github.com/${sidecarFullName}/pull/8522`,
              prState: GitHubPRState.OPEN,
              additions: 4,
              deletions: 2,
              changedFiles: 1,
            },
            select: { id: true },
          })
        );
        // The lane only runs for a tombstoned repository.
        await withDb((db) =>
          db.gitHubInstallationRepository.update({
            where: { id: ctx.repositoryId },
            data: { removedAt: new Date("2026-08-30T00:00:00.000Z") },
          })
        );

        await expect(
          githubServerSyncService.refreshTombstonedBranchPullRequest({
            actorUserId: ctx.userId,
            branchArtifactId,
            organizationId: ctx.organizationId,
          })
        ).resolves.toEqual({
          status: GitHubServerSyncStatus.NotApplicable,
          reason: GitHubServerSyncReason.NoCurrentPullRequest,
        });
        // Refused before the relink, so the stranger's row is untouched.
        await expect(
          withDb((db) =>
            db.pullRequestDetail.findUniqueOrThrow({
              where: { id: foreignPullRequest.id },
              select: { repositoryId: true, lastRefreshAttemptAt: true },
            })
          )
        ).resolves.toEqual({
          repositoryId: sidecarRepository.id,
          lastRefreshAttemptAt: null,
        });

        // Counterfactual in-test: give the SAME row the branch's repository and
        // the lane advances past this gate, so the refusal above is the
        // ownership guard rather than some unrelated precondition.
        await withDb((db) =>
          db.pullRequestDetail.update({
            where: { id: foreignPullRequest.id },
            data: { repositoryId: ctx.repositoryId },
          })
        );
        await expect(
          githubServerSyncService.refreshTombstonedBranchPullRequest({
            actorUserId: ctx.userId,
            branchArtifactId,
            organizationId: ctx.organizationId,
          })
        ).resolves.toMatchObject({
          reason: GitHubServerSyncReason.NoEligibleSessionReference,
        });
      });
    });
  }
);
