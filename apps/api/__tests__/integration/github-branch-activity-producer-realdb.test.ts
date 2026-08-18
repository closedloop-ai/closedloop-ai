import { BranchHeadShaSource } from "@repo/api/src/types/artifact";
import {
  BranchActivityAttributionKind,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { GitHubPRState } from "@repo/api/src/types/github";
import { ArtifactType, ChecksStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it, vi } from "vitest";
import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";
import { autoRollbackTransaction } from "../utils/db-helpers";
import { pullRequestEvent } from "./branch-artifact-flow-helpers";
import {
  findBranchArtifact,
  seedBranchTestContext,
} from "./branch-artifact-test-helpers";

const mocks = vi.hoisted(() => ({
  parseArtifactReferences: vi.fn().mockReturnValue([]),
  publishDirtyScopes: vi.fn().mockResolvedValue(undefined),
  reconcileLabels: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/github/artifact-reference-parser", () => ({
  parseArtifactReferences: mocks.parseArtifactReferences,
}));

vi.mock(
  "@/app/webhooks/github/handlers/pull-request-label-reconciliation",
  () => ({
    reconcilePullRequestLabelsForWebhook: mocks.reconcileLabels,
  })
);

vi.mock("@/app/webhooks/github/handlers/dirty-scope-publisher", () => ({
  publishGitHubDirtyScopes: mocks.publishDirtyScopes,
}));

const hasDatabase = Boolean(keys().DATABASE_URL);

describe.skipIf(!hasDatabase)(
  "ISS-6059 GitHub Branch activity producer (real Postgres)",
  () => {
    it("persists PR-open evidence after an existing Branch gains its first PR", async () => {
      await autoRollbackTransaction(async () => {
        const ctx = await seedBranchTestContext();
        const branchName = "iss-6059-existing-branch";
        const pullRequestCreatedAt = "2026-08-11T08:15:00.000Z";
        const deliveryId = "iss-6059-pr-opened-existing-branch";

        await withDb((db) =>
          db.artifact.create({
            data: {
              organizationId: ctx.organizationId,
              projectId: ctx.projectId,
              type: ArtifactType.BRANCH,
              name: branchName,
              status: GitHubPRState.Open,
              externalUrl: `https://github.com/${ctx.repositoryFullName}/tree/${branchName}`,
              branch: {
                create: {
                  organizationId: ctx.organizationId,
                  repositoryId: ctx.repositoryId,
                  repositoryFullName: ctx.repositoryFullName,
                  branchName,
                  headSha: "pr-head",
                  headShaSource: BranchHeadShaSource.PullRequestWebhook,
                  headShaObservedAt: new Date("2026-08-11T09:00:00.000Z"),
                  lastActivityAt: null,
                  checksStatus: ChecksStatus.UNKNOWN,
                },
              },
            },
          })
        );

        await handlePullRequest(
          pullRequestEvent(ctx, {
            branchName,
            title: "Branch PR from webhook",
            headSha: "pr-head",
            createdAt: pullRequestCreatedAt,
          }),
          {
            deliveryId,
            observedAt: new Date("2026-08-11T09:00:00.000Z"),
          }
        );

        const branch = await findBranchArtifact(ctx.repositoryId, branchName);
        const persistedActivity = await withDb((db) =>
          db.branchActivityAtom.findUnique({
            where: {
              organizationId_branchArtifactId_source_sourceEventId: {
                organizationId: ctx.organizationId,
                branchArtifactId: branch.artifactId,
                source: BranchActivitySource.PullRequestLifecycle,
                sourceEventId: deliveryId,
              },
            },
          })
        );

        expect(branch.currentPullRequestDetail).not.toBeNull();
        expect(persistedActivity).toMatchObject({
          occurredAt: new Date(pullRequestCreatedAt),
          attributionKind: BranchActivityAttributionKind.PullRequest,
          pullRequestDetailId: branch.currentPullRequestDetail?.id,
        });
        expect(branch.lastActivityAt).toEqual(new Date(pullRequestCreatedAt));
      });
    });
  }
);
