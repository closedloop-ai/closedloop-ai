import { ArtifactType, GitHubCommentThreadKind, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  upsertGitHubIssueCommentThread,
  upsertGitHubReviewCommentThread,
} from "@/app/comments/github-projection";

/**
 * DB-backed coverage for the unified GitHub comment projection.
 *
 * A real database is not incidental here — it is the point. The sibling
 * `github-projection.test.ts` drives a hand-rolled fake `tx`, which cannot
 * produce a genuine P2002, so the whole external-id collision path
 * (`isCommentThreadExternalIdUniqueError`, which parses real Prisma P2002
 * targets in both their array and string forms) is unreachable from it. The two
 * hazards this file targets are the ones `apps/api/AGENTS.md` calls out by name:
 *
 *  - "a raw GitHub comment id is not globally unique across those comment
 *    families" — the same numeric id may legitimately exist as BOTH an issue
 *    comment and a review comment, so identity must include the thread kind;
 *  - "do not assume the provider payload arrives parent-first" — a reply may be
 *    projected before the comment it replies to.
 */

const EXTERNAL_ID_CONFLICT = /external_id_conflict/;
const REQUIRES_A_COMMENT = /at least one comment/;

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

type Scope = {
  organizationId: string;
  userId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
};

async function seedBranchWithPullRequest(): Promise<Scope> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);

  const branch = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        status: "OPEN",
        name: "feat/projection",
        createdById: user.id,
      },
    })
  );
  // The projection's branchArtifactId FK points at BranchDetail.artifactId, not
  // at Artifact — a branch artifact alone is not enough to hang a thread on.
  await withDb((db) =>
    db.branchDetail.create({
      data: {
        artifactId: branch.id,
        organizationId,
        repositoryFullName: "acme/web",
        branchName: "feat/projection",
      },
    })
  );
  const pr = await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId: branch.id,
        number: 42,
        repositoryFullName: "acme/web",
      },
    })
  );

  return {
    organizationId,
    userId: user.id,
    branchArtifactId: branch.id,
    pullRequestDetailId: pr.id,
  };
}

const comment = (
  scope: Scope,
  githubCommentId: string | number,
  over = {}
) => ({
  githubCommentId,
  bodyMarkdown: "hello",
  author: { userId: scope.userId },
  createdAt: new Date("2026-08-08T00:00:00.000Z"),
  ...over,
});

const baseInput = (scope: Scope) => ({
  organizationId: scope.organizationId,
  branchArtifactId: scope.branchArtifactId,
  pullRequestDetailId: scope.pullRequestDetailId,
});

/** Count projection rows for a scope, by thread kind. */
async function threadKinds(scope: Scope): Promise<string[]> {
  const threads = await withDb((db) =>
    db.gitHubCommentThreadProjection.findMany({
      where: { branchArtifactId: scope.branchArtifactId },
      select: { threadKind: true },
    })
  );
  return threads
    .map((t) => String(t.threadKind))
    .sort((a, b) => a.localeCompare(b));
}

describeIfDb("GitHub projection — issue comment threads", () => {
  it("projects an issue comment into a thread", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedBranchWithPullRequest();

      const result = await withDb.tx((tx) =>
        upsertGitHubIssueCommentThread(tx as never, {
          ...baseInput(scope),
          comment: comment(scope, 1001),
        })
      );

      expect(result.threadId).toBeTruthy();
      expect(await threadKinds(scope)).toEqual([
        GitHubCommentThreadKind.ISSUE_COMMENT,
      ]);
    });
  });

  it("is idempotent — re-projecting the same remote id reuses the thread", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedBranchWithPullRequest();

      const first = await withDb.tx((tx) =>
        upsertGitHubIssueCommentThread(tx as never, {
          ...baseInput(scope),
          comment: comment(scope, 1001),
        })
      );
      const second = await withDb.tx((tx) =>
        upsertGitHubIssueCommentThread(tx as never, {
          ...baseInput(scope),
          comment: comment(scope, 1001, { bodyMarkdown: "edited" }),
        })
      );

      // A webhook redelivery must update in place, not fork a second thread.
      expect(second.threadId).toBe(first.threadId);
      expect(await threadKinds(scope)).toHaveLength(1);
    });
  });

  it("accepts a numeric and a string remote id as the same comment", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedBranchWithPullRequest();

      const numeric = await withDb.tx((tx) =>
        upsertGitHubIssueCommentThread(tx as never, {
          ...baseInput(scope),
          comment: comment(scope, 1001),
        })
      );
      const stringly = await withDb.tx((tx) =>
        upsertGitHubIssueCommentThread(tx as never, {
          ...baseInput(scope),
          comment: comment(scope, "1001"),
        })
      );

      expect(stringly.threadId).toBe(numeric.threadId);
    });
  });
});

describeIfDb("GitHub projection — comment-kind scoping", () => {
  it("lets the SAME raw comment id exist as both an issue and a review comment", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedBranchWithPullRequest();
      const sharedId = 2002;

      const issue = await withDb.tx((tx) =>
        upsertGitHubIssueCommentThread(tx as never, {
          ...baseInput(scope),
          comment: comment(scope, sharedId),
        })
      );
      const review = await withDb.tx((tx) =>
        upsertGitHubReviewCommentThread(tx as never, {
          ...baseInput(scope),
          rootCommentId: sharedId,
          comments: [comment(scope, sharedId)],
        })
      );

      // AGENTS.md: a raw GitHub comment id is NOT globally unique across the
      // issue-comment and review-comment families. Collapsing them would make
      // one family's comment overwrite the other's.
      expect(review.threadId).not.toBe(issue.threadId);
      expect(await threadKinds(scope)).toEqual([
        GitHubCommentThreadKind.ISSUE_COMMENT,
        GitHubCommentThreadKind.REVIEW_THREAD,
      ]);
    });
  });

  it("REJECTS the same remote id arriving under a different pull request", async () => {
    await autoRollbackTransaction(async () => {
      const scopeA = await seedBranchWithPullRequest();
      const scopeB = await seedBranchWithPullRequest();

      await withDb.tx((tx) =>
        upsertGitHubIssueCommentThread(tx as never, {
          ...baseInput(scopeA),
          comment: comment(scopeA, 3003),
        })
      );

      // `Comment.externalId` is globally unique on (threadKind, githubCommentId),
      // which matches GitHub: a comment id is unique across the whole provider,
      // so the SAME id surfacing under another PR — or another org — is corrupt
      // input, not a second legitimate comment. The guard refuses rather than
      // silently reattaching one PR's comment to another's thread.
      await expect(
        withDb.tx((tx) =>
          upsertGitHubIssueCommentThread(tx as never, {
            ...baseInput(scopeB),
            comment: comment(scopeB, 3003),
          })
        )
      ).rejects.toThrow(EXTERNAL_ID_CONFLICT);
    });
  });
});

describeIfDb("GitHub projection — review threads", () => {
  it("refuses a review thread with no comments", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedBranchWithPullRequest();

      await expect(
        withDb.tx((tx) =>
          upsertGitHubReviewCommentThread(tx as never, {
            ...baseInput(scope),
            rootCommentId: 4004,
            comments: [],
          })
        )
      ).rejects.toThrow(REQUIRES_A_COMMENT);
    });
  });

  it("projects every comment in a review thread onto one thread", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedBranchWithPullRequest();

      const result = await withDb.tx((tx) =>
        upsertGitHubReviewCommentThread(tx as never, {
          ...baseInput(scope),
          rootCommentId: 5005,
          comments: [
            comment(scope, 5005),
            comment(scope, 5006, { githubInReplyToCommentId: 5005 }),
          ],
        })
      );

      const projected = await withDb((db) =>
        db.gitHubCommentProjection.findMany({
          where: { threadId: result.threadId },
          select: { githubCommentId: true },
        })
      );
      expect(projected).toHaveLength(2);
      expect(await threadKinds(scope)).toEqual([
        GitHubCommentThreadKind.REVIEW_THREAD,
      ]);
    });
  });

  it("links a reply to its parent even when the reply is projected FIRST", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedBranchWithPullRequest();

      // AGENTS.md: do not assume the provider payload arrives parent-first.
      // The reply precedes its parent in the array on purpose.
      const result = await withDb.tx((tx) =>
        upsertGitHubReviewCommentThread(tx as never, {
          ...baseInput(scope),
          rootCommentId: 6006,
          comments: [
            comment(scope, 6007, { githubInReplyToCommentId: 6006 }),
            comment(scope, 6006),
          ],
        })
      );

      const reply = await withDb((db) =>
        db.gitHubCommentProjection.findFirst({
          where: { threadId: result.threadId, githubCommentId: "6007" },
          select: { comment: { select: { parentCommentId: true } } },
        })
      );
      // The backfill pass must have resolved the parent link despite the order.
      expect(reply?.comment.parentCommentId).not.toBeNull();
    });
  });

  it("leaves a reply whose parent is absent from the payload unlinked", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedBranchWithPullRequest();

      const result = await withDb.tx((tx) =>
        upsertGitHubReviewCommentThread(tx as never, {
          ...baseInput(scope),
          rootCommentId: 7007,
          comments: [
            comment(scope, 7007),
            comment(scope, 7008, { githubInReplyToCommentId: 9999 }),
          ],
        })
      );

      const orphan = await withDb((db) =>
        db.gitHubCommentProjection.findFirst({
          where: { threadId: result.threadId, githubCommentId: "7008" },
          select: { comment: { select: { parentCommentId: true } } },
        })
      );
      // An unresolvable parent is left null rather than guessed at.
      expect(orphan?.comment.parentCommentId).toBeNull();
    });
  });
});
