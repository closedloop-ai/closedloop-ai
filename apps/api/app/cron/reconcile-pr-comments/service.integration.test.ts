/**
 * ISS-11212 (PLN-2122 Step 5): which pull requests one cron run reconciles,
 * in what order, and that one pull request's failure does not stop the rest.
 * The reconcile itself is stubbed; its own suite covers what it writes.
 */
import { GitHubPRState, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { reconcileMock } = vi.hoisted(() => ({ reconcileMock: vi.fn() }));

vi.mock(
  "@/app/comments/service/github/github-comment-reconcile",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/comments/service/github/github-comment-reconcile")
    >()),
    reconcilePullRequestComments: reconcileMock,
  })
);

import {
  type GitHubCommentScope,
  seedGitHubCommentScope,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import {
  autoRollbackTransactionJoining,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import {
  GitHubCommentReconcileReason,
  GitHubCommentReconcileStatus,
} from "@/app/comments/service/github/github-comment-reconcile";
import {
  PullRequestCommentReconcileRunStatus,
  RECONCILE_PR_COMMENTS_BATCH,
  RECONCILE_PR_COMMENTS_RUN_EVENT,
  runPullRequestCommentReconcile,
} from "./service";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const joinAmbientTransaction = autoRollbackTransactionJoining(
  "the reconcile is stubbed; these cases assert the due-PR scan and the run summary, which open no per-chunk transaction of their own"
);

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

async function setPullRequest(
  scope: GitHubCommentScope,
  data: {
    prState?: GitHubPRState;
    commentsReconciledAt?: Date | null;
    commentsReconcileAttemptedAt?: Date | null;
    commentsReconcileClaimedAt?: Date | null;
  }
): Promise<void> {
  await withDb((db) =>
    db.pullRequestDetail.update({
      where: { id: scope.pullRequestDetailId },
      data,
      select: { id: true },
    })
  );
}

/**
 * The due scan is global and takes `RECONCILE_PR_COMMENTS_BATCH` rows, so open
 * pull requests other suites committed to the shared integration database
 * (never attempted, so they sort first) can fill the batch ahead of this
 * case's own. Leasing every other org's open pull request inside the case's
 * rolled-back transaction leaves the scan only this case's rows to order.
 * A lease, not an attempt stamp, so the overdue count is unchanged.
 */
async function leaseOtherOrgsPullRequests(
  organizationId: string
): Promise<void> {
  await withDb((db) =>
    db.pullRequestDetail.updateMany({
      where: {
        organizationId: { not: organizationId },
        prState: GitHubPRState.OPEN,
      },
      data: { commentsReconcileClaimedAt: new Date() },
    })
  );
}

async function seedScopes(
  organizationId: string,
  count: number
): Promise<GitHubCommentScope[]> {
  const scopes: GitHubCommentScope[] = [];
  for (let number = 1; number <= count; number += 1) {
    scopes.push(await seedGitHubCommentScope(organizationId, { number }));
  }
  return scopes;
}

/**
 * One pull request per side of each due-scan condition. Overdue: `never`,
 * `older`, `newer`, `leased`, `failedRecently`.
 */
async function seedFloorScopes(organizationId: string) {
  const [never, older, newer, recent, failedRecently, closed, leased] =
    await seedScopes(organizationId, 7);
  if (
    !(never && older && newer && recent && failedRecently && closed && leased)
  ) {
    throw new Error("expected seven seeded pull requests");
  }
  const notCurrent = await seedGitHubCommentScope(organizationId, {
    number: 8,
    current: false,
  });
  await withDb((db) =>
    db.branchDetail.update({
      where: { artifactId: notCurrent.branchArtifactId },
      data: { currentPullRequestDetailId: never.pullRequestDetailId },
      select: { artifactId: true },
    })
  );
  const now = Date.now();
  await setPullRequest(older, {
    commentsReconciledAt: new Date(now - 3 * HOUR),
  });
  await setPullRequest(newer, {
    commentsReconciledAt: new Date(now - 2 * HOUR),
  });
  await setPullRequest(recent, {
    commentsReconciledAt: new Date(now - 10 * MINUTE),
  });
  await setPullRequest(failedRecently, {
    commentsReconcileAttemptedAt: new Date(now - 10 * MINUTE),
  });
  await setPullRequest(closed, { prState: GitHubPRState.CLOSED });
  await setPullRequest(leased, {
    commentsReconcileClaimedAt: new Date(now - MINUTE),
  });
  return {
    never,
    older,
    newer,
    recent,
    failedRecently,
    closed,
    leased,
    notCurrent,
  };
}

function reconciled() {
  return {
    status: GitHubCommentReconcileStatus.Reconciled,
    reasons: [],
    appliedEvents: 2,
    signals: 2,
  };
}

describeIfDb("runPullRequestCommentReconcile", () => {
  beforeEach(() => {
    reconcileMock.mockReset();
    reconcileMock.mockResolvedValue(reconciled());
  });

  it("takes open, current, unleased pull requests past the freshness floor, never-reconciled first then oldest", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const scopes = await seedFloorScopes(organizationId);
      await leaseOtherOrgsPullRequests(organizationId);

      await runPullRequestCommentReconcile();

      const ours = new Set(
        Object.values(scopes).map((scope) => scope.pullRequestDetailId)
      );
      const taken = reconcileMock.mock.calls
        .map(([input]) => input.pullRequestDetailId)
        .filter((id) => ours.has(id));
      expect(taken).toEqual([
        scopes.never.pullRequestDetailId,
        scopes.older.pullRequestDetailId,
        scopes.newer.pullRequestDetailId,
      ]);
    });
  });

  it("counts eligible pull requests past the freshness floor as overdue, leased and backing-off ones included", async () => {
    await joinAmbientTransaction(async () => {
      const before = await runPullRequestCommentReconcile();
      const organizationId = await createTestOrganization();
      await seedFloorScopes(organizationId);

      const summary = await runPullRequestCommentReconcile();

      expect(Number.isInteger(summary.overdue)).toBe(true);
      expect(summary.overdue - before.overdue).toBe(5);
    });
  });

  it("does not let more failing pull requests than the batch hold it run after run", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const failing = await seedScopes(
        organizationId,
        RECONCILE_PR_COMMENTS_BATCH + 1
      );
      const reconciledLongAgo = await seedGitHubCommentScope(organizationId, {
        number: RECONCILE_PR_COMMENTS_BATCH + 2,
      });
      await setPullRequest(reconciledLongAgo, {
        commentsReconciledAt: new Date(Date.now() - 2 * HOUR),
      });
      await leaseOtherOrgsPullRequests(organizationId);
      // What a failed reconcile leaves behind: no reconciled marker, a
      // released lease, and the attempt stamped on release.
      reconcileMock.mockImplementation(
        async (input: { pullRequestDetailId: string }) => {
          await withDb((db) =>
            db.pullRequestDetail.update({
              where: { id: input.pullRequestDetailId },
              data: { commentsReconcileAttemptedAt: new Date() },
              select: { id: true },
            })
          );
          return {
            status: GitHubCommentReconcileStatus.ProviderError,
            errorCode: "no_installation",
            reasons: [],
            appliedEvents: 0,
            signals: 0,
          };
        }
      );
      const ours = new Set(
        [...failing, reconciledLongAgo].map(
          (scope) => scope.pullRequestDetailId
        )
      );
      const takenBy = async () => {
        reconcileMock.mockClear();
        await runPullRequestCommentReconcile();
        return reconcileMock.mock.calls
          .map(([input]) => input.pullRequestDetailId as string)
          .filter((id) => ours.has(id));
      };

      const first = await takenBy();
      const second = await takenBy();

      // More of ours are due than one batch holds, so some wait for the second
      // run; they and the long-reconciled one go before any that just failed.
      const leftOut = failing
        .map((scope) => scope.pullRequestDetailId)
        .filter((id) => !first.includes(id))
        .sort();
      expect(leftOut.length).toBeGreaterThan(0);
      expect(second.slice(0, leftOut.length + 1)).toEqual([
        ...leftOut,
        reconciledLongAgo.pullRequestDetailId,
      ]);
    });
  });

  it("isolates a pull request whose reconcile throws and summarizes the run", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const scopes = await seedScopes(organizationId, 3);
      const failing = scopes[1]?.pullRequestDetailId;
      await leaseOtherOrgsPullRequests(organizationId);
      reconcileMock.mockImplementation(
        (input: { pullRequestDetailId: string }) => {
          if (input.pullRequestDetailId === failing) {
            return Promise.reject(new Error("transaction timed out"));
          }
          return Promise.resolve({
            status: GitHubCommentReconcileStatus.Partial,
            reasons: [GitHubCommentReconcileReason.ListCeiling],
            appliedEvents: 1,
            signals: 1,
          });
        }
      );

      const summary = await runPullRequestCommentReconcile();

      expect(summary).toEqual(
        expect.objectContaining({
          event: RECONCILE_PR_COMMENTS_RUN_EVENT,
          status: PullRequestCommentReconcileRunStatus.Degraded,
          failed: 1,
          partial: summary.due - 1,
          reasons: [GitHubCommentReconcileReason.ListCeiling],
        })
      );
      expect(reconcileMock).toHaveBeenCalledTimes(summary.due);
    });
  });
});
