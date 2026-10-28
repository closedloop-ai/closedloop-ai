/**
 * ISS-11212 against a real Postgres: a list cleanup reads a stale comment, and
 * a webhook edit of that comment commits before the cleanup's write. The
 * write must re-check the list bound on the committed row and keep the comment.
 * The webhook is held open mid-transaction so the cleanup's write queues on
 * its row; an ambient rollback transaction would put both on one connection
 * and prove nothing, so this suite commits and cleans up its organizations.
 */
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { GitHubProviderResultStatus } from "@repo/github/provider-result";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyInput,
  at,
  issueCommentEvent,
  seedGitHubCommentScope,
  storedComment,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import {
  backendPid,
  PendingCallState,
  untilSettledOrBlockedBy,
} from "@/__tests__/support/comments/lock-wait.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { backfillFetchProvenance } from "@/lib/github-fetch-provenance";
import { applyExternal } from "./apply-external";
import { reconcilePullRequestComments } from "./github-comment-reconcile";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const organizations = createCommittedTestOrganizationTracker();

function emptyCompleteList<T>() {
  const items: T[] = [];
  return {
    status: GitHubProviderResultStatus.Success,
    value: { items, complete: true },
  } as const;
}

describeIfDb("list cleanup vs a webhook committing inside its window", () => {
  afterEach(async () => {
    await organizations.cleanup();
  });

  it("keeps a comment a webhook edited after the list was read", async () => {
    const scope = await seedGitHubCommentScope(await organizations.create());
    await applyExternal(
      applyInput(scope, [issueCommentEvent(123, { providerUpdatedAt: at(1) })])
    );
    const commentId = (await storedComment(scope, 123))?.commentId ?? "";
    const listedAt = new Date();

    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written: (pid: number) => void = () => undefined;
    const wrote = new Promise<number>((resolve) => {
      written = resolve;
    });
    const webhook = withDb.tx(async (tx) => {
      await tx.gitHubCommentProjection.update({
        where: { commentId },
        data: { githubUpdatedAt: new Date(listedAt.getTime() + 2000) },
        select: { commentId: true },
      });
      written(await backendPid(tx));
      await released;
    });
    const webhookPid = await wrote;

    const cleanup = reconcilePullRequestComments({
      pullRequestDetailId: scope.pullRequestDetailId,
      prefetched: {
        issueComments: emptyCompleteList(),
        reviewComments: emptyCompleteList(),
        reviews: emptyCompleteList(),
        listedAt,
        fetchProvenance: backfillFetchProvenance(),
      },
    });
    expect(await untilSettledOrBlockedBy(cleanup, webhookPid)).toBe(
      PendingCallState.Blocked
    );
    release();
    await Promise.all([webhook, cleanup]);

    const stored = await storedComment(scope, 123);
    expect(stored?.githubDeletedAt).toBeNull();
    expect(stored?.comment.deletedAt).toBeNull();
  });
});
