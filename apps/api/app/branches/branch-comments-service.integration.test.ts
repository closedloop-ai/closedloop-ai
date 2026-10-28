import { BranchCommentsState } from "@repo/api/src/types/branch";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import {
  ExternalCommentProvider,
  GitHubCommentThreadKind,
  ThreadSource,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import {
  type SeededOrg,
  SHARED_REPO_FULL_NAME,
  seedTwoOrgFixture,
} from "@/__tests__/utils/two-org-fixture";
import { branchCommentsService } from "./branch-comments-service";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;
const organizations = createCommittedTestOrganizationTracker();

afterEach(() => organizations.cleanup());

describeIfDb("branch comment author organization isolation (ISS-10643)", () => {
  it("retains both comments but redacts every foreign-org author field", async () => {
    const { orgA, orgB } = await seedTwoOrgFixture();
    organizations.track(orgA.organizationId);
    organizations.track(orgB.organizationId);
    const pullRequest = await withDb((db) =>
      db.pullRequestDetail.create({
        data: {
          organizationId: orgA.organizationId,
          branchArtifactId: orgA.branchArtifactId,
          repositoryId: orgA.repositoryId,
          repositoryFullName: SHARED_REPO_FULL_NAME,
          number: 1,
          title: "Comment author isolation",
          // Reconciled, so the read serves the seeded rows without a first-view
          // reconcile reaching GitHub.
          commentsReconcileAttemptedAt: new Date("2026-09-01T00:00:00.000Z"),
          commentsReconciledAt: new Date("2026-09-01T00:00:01.000Z"),
        },
        select: { id: true },
      })
    );
    const local = await seedProjectedComment(orgA, orgA, pullRequest.id, "ada");
    // The projection has no organization_id/composite author FK: this malformed
    // pairing is accepted by Postgres, not simulated by a mocked query result.
    const foreign = await seedProjectedComment(
      orgA,
      orgB,
      pullRequest.id,
      "mallory"
    );

    const result = await branchCommentsService.getBranchComments(
      orgA.organizationId,
      orgA.branchArtifactId,
      { repositoryFullName: SHARED_REPO_FULL_NAME, pullRequestNumber: 1 }
    );

    expect(result?.state).toBe(BranchCommentsState.Populated);
    expect(result?.comments).toHaveLength(2);
    const localComment = result?.comments.find(
      (comment) => comment.id === local
    );
    const foreignComment = result?.comments.find(
      (comment) => comment.id === foreign
    );
    expect(localComment?.author).toEqual({
      login: "ada",
      displayName: "ada display name",
      avatarUrl: "https://avatars.example/ada.png",
      profileUrl: "https://github.com/ada",
      actorType: GitHubActorType.Bot,
    });
    expect(foreignComment?.author).toEqual({
      login: "unknown",
      displayName: null,
      avatarUrl: null,
      profileUrl: null,
    });
    for (const [comment, label] of [
      [localComment, "ada"],
      [foreignComment, "mallory"],
    ] as const) {
      expect(comment?.body).toBe(`${label} comment body`);
      expect(comment?.providerCommentId).toBe(`github-${label}`);
      expect(comment?.providerUrl).toBe(
        `https://github.com/acme/app/pull/1#${label}`
      );
    }
  });
});

function seedProjectedComment(
  branchOrg: SeededOrg,
  authorOrg: SeededOrg,
  pullRequestDetailId: string,
  label: string
): Promise<string> {
  return withDb(async (db) => {
    const author = await db.externalCommentAuthor.create({
      data: {
        organizationId: authorOrg.organizationId,
        provider: ExternalCommentProvider.GITHUB,
        providerUserId: label,
        providerLogin: label,
        normalizedProviderLogin: label,
        displayName: `${label} display name`,
        avatarUrl: `https://avatars.example/${label}.png`,
        profileUrl: `https://github.com/${label}`,
        providerDetail: { actorType: GitHubActorType.Bot },
        userId: authorOrg.userId,
      },
      select: { id: true },
    });
    const thread = await db.commentThread.create({
      data: {
        organizationId: branchOrg.organizationId,
        artifactId: branchOrg.branchArtifactId,
        source: ThreadSource.GITHUB,
      },
      select: { id: true },
    });
    await db.gitHubCommentThreadProjection.create({
      data: {
        threadId: thread.id,
        branchArtifactId: branchOrg.branchArtifactId,
        pullRequestDetailId,
        threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
      },
      select: { threadId: true },
    });
    const comment = await db.comment.create({
      data: {
        threadId: thread.id,
        authorId: branchOrg.userId,
        body: {},
        bodyFormat: CommentBodyFormat.Markdown,
        plainText: `${label} comment body`,
      },
      select: { id: true },
    });
    await db.gitHubCommentProjection.create({
      data: {
        commentId: comment.id,
        threadId: thread.id,
        externalAuthorId: author.id,
        githubCommentId: `github-${label}`,
        githubHtmlUrl: `https://github.com/acme/app/pull/1#${label}`,
      },
      select: { commentId: true },
    });
    return comment.id;
  });
}
