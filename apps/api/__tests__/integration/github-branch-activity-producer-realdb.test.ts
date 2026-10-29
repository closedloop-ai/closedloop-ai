import { BranchHeadShaSource } from "@repo/api/src/types/artifact";
import {
  BranchActivityAttributionKind,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { GitHubPRState } from "@repo/api/src/types/github";
import { ArtifactType, ChecksStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it, vi } from "vitest";
import { persistPullRequestLifecycleActivityInTransaction } from "@/app/branches/pull-request-lifecycle-activity";
import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";
import { autoRollbackTransactionJoining } from "../utils/db-helpers";
import { pullRequestEvent } from "./branch-artifact-flow-helpers";
import {
  findBranchArtifact,
  seedBranchTestContext,
} from "./branch-artifact-test-helpers";

/**
 * ISS-11104 — this suite lets its ambient transaction absorb the nested
 * `withDb.tx` its production path opens, discarding that call's own budget.
 * The reason below is the whole statement: it is what a reviewer reads to tell
 * a suite that does not need the real boundary from one that is blind to it.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases pin what the pull-request webhook produces as branch activity, not the commit boundary its handler's transaction opens"
);

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
      await joinAmbientTransaction(async () => {
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
        const pullRequestDetailId = branch.currentPullRequestDetail?.id;
        expect(pullRequestDetailId).toBeDefined();
        const persistedActivity = await withDb((db) =>
          db.branchActivityAtom.findUnique({
            where: {
              organizationId_branchArtifactId_source_sourceEventId: {
                organizationId: ctx.organizationId,
                branchArtifactId: branch.artifactId,
                source: BranchActivitySource.PullRequestLifecycle,
                // ISS-7018: keyed by the occurrence, not by `deliveryId`.
                sourceEventId: `${pullRequestDetailId}:opened`,
              },
            },
          })
        );

        expect(persistedActivity).toMatchObject({
          occurredAt: new Date(pullRequestCreatedAt),
          attributionKind: BranchActivityAttributionKind.PullRequest,
          pullRequestDetailId,
        });
        expect(branch.lastActivityAt).toEqual(new Date(pullRequestCreatedAt));
      });
    });

    it("records one atom per occurrence when the backfill lane replays webhooks", async () => {
      await joinAmbientTransaction(async () => {
        const ctx = await seedBranchTestContext();
        const branchName = "iss-7018-cross-lane-branch";
        const pullRequestCreatedAt = "2026-08-11T08:15:00.000Z";
        // Second-precision, the way GitHub actually sends it, so the close key
        // only converges if both lanes normalize before keying.
        const pullRequestClosedAt = "2026-08-11T10:30:00Z";

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

        const openedEvent = pullRequestEvent(ctx, {
          branchName,
          title: "Branch PR from webhook",
          headSha: "pr-head",
          createdAt: pullRequestCreatedAt,
        });
        await handlePullRequest(openedEvent, {
          deliveryId: "iss-7018-pr-opened",
          observedAt: new Date("2026-08-11T09:00:00.000Z"),
        });
        await handlePullRequest(
          {
            ...openedEvent,
            action: "closed",
            pull_request: {
              ...openedEvent.pull_request,
              state: "closed",
              merged: false,
              closed_at: pullRequestClosedAt,
            },
          },
          {
            deliveryId: "iss-7018-pr-closed",
            observedAt: new Date("2026-08-11T11:00:00.000Z"),
          }
        );

        const branch = await findBranchArtifact(ctx.repositoryId, branchName);
        const pullRequestDetailId = branch.currentPullRequestDetail?.id;
        if (!pullRequestDetailId) {
          throw new Error("webhook did not create the pull request detail");
        }

        // The non-webhook lane the GitHub App backfill and tombstoned-repo
        // settlement both go through, replaying the same real-world events.
        await withDb((db) =>
          persistPullRequestLifecycleActivityInTransaction(db, {
            organizationId: ctx.organizationId,
            branchArtifactId: branch.artifactId,
            pullRequestDetailId,
            openedAt: new Date(pullRequestCreatedAt),
            mergedAt: null,
            closedAt: new Date(pullRequestClosedAt),
          })
        );

        const atoms = await withDb((db) =>
          db.branchActivityAtom.findMany({
            where: {
              organizationId: ctx.organizationId,
              branchArtifactId: branch.artifactId,
              source: BranchActivitySource.PullRequestLifecycle,
            },
            orderBy: { occurredAt: "asc" },
            select: { sourceEventId: true, occurredAt: true },
          })
        );

        expect(atoms).toEqual([
          {
            sourceEventId: `${pullRequestDetailId}:opened`,
            occurredAt: new Date(pullRequestCreatedAt),
          },
          {
            sourceEventId: `${pullRequestDetailId}:closed:${new Date(
              pullRequestClosedAt
            ).toISOString()}`,
            occurredAt: new Date(pullRequestClosedAt),
          },
        ]);
      });
    });
  }
);
