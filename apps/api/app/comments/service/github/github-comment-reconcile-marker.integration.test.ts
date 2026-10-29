/**
 * ISS-11212 (PLN-2122 Step 6): the reconcile marker the Branch PR comments
 * read derives freshness from (Kerensa, 2026-10-05): a latest attempt that did
 * not complete counts as failed once its lease is free again.
 */
import { randomUUID } from "node:crypto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import type { GitHubCommentScope } from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import { seed } from "@/__tests__/support/comments/github-comment-reconcile.test-fixtures";
import { autoRollbackTransactionJoining } from "@/__tests__/utils/db-helpers";
import { RECONCILE_PR_COMMENTS_FRESHNESS_FLOOR_MINUTES } from "./github-comment-reconcile";
import { readPullRequestCommentsReconcileMarker } from "./github-comment-reconcile-marker";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const joinAmbientTransaction = autoRollbackTransactionJoining(
  "every case reads one marker row it just wrote; no case depends on a commit"
);

const MINUTE = 60_000;

async function stamp(
  scope: GitHubCommentScope,
  stamps: {
    attemptedAt?: Date | null;
    reconciledAt?: Date | null;
    claimedAt?: Date | null;
  }
) {
  await withDb((db) =>
    db.pullRequestDetail.update({
      where: { id: scope.pullRequestDetailId },
      data: {
        commentsReconcileAttemptedAt: stamps.attemptedAt ?? null,
        commentsReconciledAt: stamps.reconciledAt ?? null,
        commentsReconcileClaimedAt: stamps.claimedAt ?? null,
      },
      select: { id: true },
    })
  );
}

function read(scope: GitHubCommentScope) {
  return readPullRequestCommentsReconcileMarker(
    scope.organizationId,
    scope.pullRequestDetailId
  );
}

describeIfDb("readPullRequestCommentsReconcileMarker", () => {
  it("reports a pull request never attempted as unsynced, not failed", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();

      expect(await read(scope)).toEqual({
        reconciledAt: null,
        latestAttemptFailed: false,
        attemptDue: true,
      });
    });
  });

  it("reports an attempt after the last complete reconcile, with a free lease, as failed", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      const reconciledAt = new Date(Date.now() - 30 * MINUTE);
      await stamp(scope, {
        reconciledAt,
        attemptedAt: new Date(Date.now() - 20 * MINUTE),
      });

      expect(await read(scope)).toEqual({
        reconciledAt,
        latestAttemptFailed: true,
        attemptDue: false,
      });
    });
  });

  it("reports an attempt as due only once it is older than the freshness floor", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      const floor = RECONCILE_PR_COMMENTS_FRESHNESS_FLOOR_MINUTES * MINUTE;
      await stamp(scope, {
        attemptedAt: new Date(Date.now() - floor + MINUTE),
      });
      expect((await read(scope))?.attemptDue).toBe(false);

      await stamp(scope, {
        attemptedAt: new Date(Date.now() - floor - MINUTE),
      });
      expect((await read(scope))?.attemptDue).toBe(true);
    });
  });

  it("reports an attempt no reconcile ever completed, with a free lease, as failed", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      await stamp(scope, { attemptedAt: new Date(Date.now() - 20 * MINUTE) });

      expect((await read(scope))?.latestAttemptFailed).toBe(true);
    });
  });

  it("does not report the attempt a complete reconcile followed as failed", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      await stamp(scope, {
        attemptedAt: new Date(Date.now() - 20 * MINUTE),
        reconciledAt: new Date(Date.now() - 19 * MINUTE),
      });

      expect((await read(scope))?.latestAttemptFailed).toBe(false);
    });
  });

  it("does not report an attempt still holding its lease as failed, until the lease expires", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      const attemptedAt = new Date(Date.now() - MINUTE);
      await stamp(scope, { attemptedAt, claimedAt: attemptedAt });
      expect((await read(scope))?.latestAttemptFailed).toBe(false);

      const expired = new Date(Date.now() - 11 * MINUTE);
      await stamp(scope, { attemptedAt: expired, claimedAt: expired });
      expect((await read(scope))?.latestAttemptFailed).toBe(true);
    });
  });

  it("reads nothing for another organization's pull request", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();

      expect(
        await readPullRequestCommentsReconcileMarker(
          randomUUID(),
          scope.pullRequestDetailId
        )
      ).toBeNull();
    });
  });
});
