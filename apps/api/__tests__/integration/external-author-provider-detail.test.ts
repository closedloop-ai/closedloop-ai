import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubLegacyCommentState, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it, vi } from "vitest";
import { branchCommentsService } from "@/app/branches/branch-comments-service";
import { resolveExternalGitHubAuthor } from "@/app/comments/external-authors";
import { upsertGitHubIssueCommentThread } from "@/app/comments/github-projection";
import {
  autoRollbackTransaction,
  createTestOrganization,
  linkValidSessionToBranch,
} from "../utils/db-helpers";
import { seedBranchWithCurrentPr } from "./branch-artifact-flow-helpers";
import { seedBranchTestContext } from "./branch-artifact-test-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/github")>();
  const success = async () => ({
    status: actual.GitHubProviderResultStatus.Success,
    value: [],
  });
  return {
    ...actual,
    listPullRequestIssueCommentsWithProviderResult: success,
    listPullRequestReviewCommentsWithProviderResult: success,
    listPullRequestReviewsWithProviderResult: success,
  };
});

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: async () => ({}),
}));

vi.mock("@/lib/github/github-branch-view-read-client", () => ({
  resolveBranchViewReadClient: async () => ({
    ok: true,
    value: { octokit: {}, kind: "user_token" },
  }),
}));

describe.skipIf(!hasDatabase)("external author actor type persistence", () => {
  it("round-trips actor type while preserving sibling metadata and missing updates", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const source = {
        sourceKind: "issue_comment" as const,
        githubObjectId: "actor-type-round-trip",
      };
      const baseAuthor = {
        id: 998_877,
        login: "octocat",
        node_id: "U_actor_type_round_trip",
        avatar_url: null,
        html_url: "https://github.com/octocat",
      };

      const initial = await resolveExternalGitHubAuthor({
        organizationId,
        author: { ...baseAuthor, type: GitHubActorType.User },
        source,
      });
      await withDb((db) =>
        db.externalCommentAuthor.update({
          where: { id: initial.externalAuthor.id },
          data: {
            providerDetail: {
              actorType: GitHubActorType.User,
              retained: "sibling-value",
            },
          },
        })
      );

      await resolveExternalGitHubAuthor({
        organizationId,
        author: baseAuthor,
        source,
      });
      const afterMissing = await readProviderDetail(initial.externalAuthor.id);
      expect(afterMissing).toEqual({
        actorType: GitHubActorType.User,
        retained: "sibling-value",
      });

      await resolveExternalGitHubAuthor({
        organizationId,
        author: { ...baseAuthor, actorType: GitHubActorType.Bot },
        source,
      });
      const afterUpdate = await readProviderDetail(initial.externalAuthor.id);
      expect(afterUpdate).toEqual({
        actorType: GitHubActorType.Bot,
        retained: "sibling-value",
      });
    });
  });

  it("projects persisted actor type through the Branch comments service", async () => {
    await autoRollbackTransaction(async () => {
      const context = await seedBranchTestContext();
      const branch = await seedBranchWithCurrentPr(context, {
        branchName: "feature/actor-type-projection",
        prNumber: 4981,
      });
      await linkValidSessionToBranch({
        organizationId: context.organizationId,
        userId: context.userId,
        branchArtifactId: branch.artifactId,
        label: "actor-type-projection",
      });
      const source = {
        sourceKind: "issue_comment" as const,
        githubObjectId: "actor-type-projection",
      };
      const baseAuthor = {
        id: 998_878,
        login: "octocat",
        node_id: "U_actor_type_projection",
        avatar_url: null,
        html_url: "https://github.com/octocat",
      };
      const resolved = await resolveExternalGitHubAuthor({
        organizationId: context.organizationId,
        author: { ...baseAuthor, type: GitHubActorType.User },
        source,
      });

      await resolveExternalGitHubAuthor({
        organizationId: context.organizationId,
        author: baseAuthor,
        source,
      });
      await withDb.tx((tx) =>
        upsertGitHubIssueCommentThread(tx, {
          organizationId: context.organizationId,
          branchArtifactId: branch.artifactId,
          pullRequestDetailId: branch.prDetailId,
          htmlUrl: "https://github.com/owner/repo/pull/4981#issuecomment-9001",
          legacyState: GitHubLegacyCommentState.PENDING,
          lastSyncedAt: new Date("2026-08-03T20:00:00.000Z"),
          comment: {
            githubCommentId: "9001",
            githubHtmlUrl:
              "https://github.com/owner/repo/pull/4981#issuecomment-9001",
            githubUpdatedAt: new Date("2026-08-03T20:00:00.000Z"),
            bodyMarkdown: "Actor type survives persistence and projection.",
            createdAt: new Date("2026-08-03T19:59:00.000Z"),
            author: {
              userId: resolved.user.id,
              externalAuthorId: resolved.externalAuthor.id,
            },
          },
        })
      );

      const response = await branchCommentsService.getBranchComments(
        context.organizationId,
        branch.artifactId
      );

      expect(response?.comments).toEqual([
        expect.objectContaining({
          author: expect.objectContaining({
            actorType: GitHubActorType.User,
          }),
        }),
      ]);
    });
  });
});

async function readProviderDetail(id: string) {
  return await withDb(async (db) => {
    const row = await db.externalCommentAuthor.findUniqueOrThrow({
      where: { id },
      select: { providerDetail: true },
    });
    return row.providerDetail;
  });
}
