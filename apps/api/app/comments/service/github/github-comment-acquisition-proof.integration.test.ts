/**
 * ISS-11767 (PLN-2174 Step 2): the reconcile records each lane's outcome in
 * `pull_request_comment_acquisitions` when it releases its lease, latest
 * attempt winning, and records nothing for a run that no longer holds it.
 */
import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import {
  PullRequestCommentLane,
  PullRequestCommentLaneStatus,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { GitHubProviderResultStatus } from "@repo/github/provider-result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApplyExternalModule from "./apply-external";

const mocks = vi.hoisted(() => ({
  issueComments: vi.fn(),
  reviewComments: vi.fn(),
  reviews: vi.fn(),
  getGitHubSyncClient: vi.fn(),
  applyFails: false,
}));

vi.mock("@repo/github/pull-request-comment-lists", () => ({
  listAllPullRequestIssueComments: mocks.issueComments,
  listAllPullRequestReviewComments: mocks.reviewComments,
  listAllPullRequestReviews: mocks.reviews,
}));

vi.mock("@/lib/github/github-sync-client-pool", () => ({
  getGitHubSyncClient: mocks.getGitHubSyncClient,
}));

vi.mock("./apply-external", async (importOriginal) => {
  const actual = await importOriginal<typeof ApplyExternalModule>();
  return {
    ...actual,
    applyExternal: (input: Parameters<typeof actual.applyExternal>[0]) =>
      mocks.applyFails
        ? Promise.reject(new Error(APPLY_FAILURE_MESSAGE))
        : actual.applyExternal(input),
  };
});

import {
  applyInput,
  type GitHubCommentScope,
  issueCommentEvent,
  providerIssueComment,
  providerReview,
  storedComment,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import {
  list,
  lists,
  reconcile,
  seed,
} from "@/__tests__/support/comments/github-comment-reconcile.test-fixtures";
import { autoRollbackTransactionJoining } from "@/__tests__/utils/db-helpers";
import { applyExternal } from "./apply-external";
import { AcquisitionFailureCode } from "./github-comment-acquisition-proof";
import { GitHubCommentReconcileStatus } from "./github-comment-reconcile";

const APPLY_FAILURE_MESSAGE = "ISS-11767 apply failure";
const READ_FAILURE_MESSAGE = "ISS-11767 read failure";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const joinAmbientTransaction = autoRollbackTransactionJoining(
  "every case asserts the proof rows the release wrote, not the release transaction's commit boundary"
);

const FAILED = { status: GitHubProviderResultStatus.ProviderUnavailable };

async function proofRows(scope: GitHubCommentScope) {
  return await withDb((db) =>
    db.pullRequestCommentAcquisition.findMany({
      where: { pullRequestDetailId: scope.pullRequestDetailId },
      orderBy: { lane: "asc" },
      select: {
        lane: true,
        organizationId: true,
        generation: true,
        status: true,
        itemCount: true,
        errorCode: true,
        listedAt: true,
        lastCompleteListedAt: true,
        incompleteStreak: true,
        retractedCount: true,
      },
    })
  );
}

async function laneRow(
  scope: GitHubCommentScope,
  lane: PullRequestCommentLane
) {
  const rows = await proofRows(scope);
  return rows.find((row) => row.lane === lane);
}

function mockFetchedLists(
  issueComments: unknown = list([]),
  onRead: () => Promise<void> = async () => undefined
): void {
  mocks.getGitHubSyncClient.mockResolvedValue({
    ok: true,
    value: {
      octokit: {},
      kind: GitHubCredentialKind.Installation,
      credentialOwnerId: null,
    },
  });
  mocks.issueComments.mockImplementation(async () => {
    await onRead();
    return issueComments;
  });
  mocks.reviewComments.mockResolvedValue(list([]));
  mocks.reviews.mockResolvedValue(list([]));
}

describeIfDb("reconcilePullRequestComments — lane acquisition proof", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyFails = false;
  });

  it("records three COMPLETE lanes with their item counts, a zero-item list as proven empty", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      const read = lists({
        issueComments: list([providerIssueComment(1), providerIssueComment(2)]),
        reviews: list([providerReview(7, "Looks good")]),
      });

      const result = await reconcile(scope, read);

      expect(result.status).toBe(GitHubCommentReconcileStatus.Reconciled);
      const base = {
        organizationId: scope.organizationId,
        generation: 1,
        status: PullRequestCommentLaneStatus.COMPLETE,
        errorCode: null,
        listedAt: read.listedAt,
        lastCompleteListedAt: read.listedAt,
        incompleteStreak: 0,
        retractedCount: 0,
      };
      expect(await proofRows(scope)).toEqual([
        { ...base, lane: PullRequestCommentLane.ISSUE_COMMENTS, itemCount: 2 },
        { ...base, lane: PullRequestCommentLane.REVIEW_COMMENTS, itemCount: 0 },
        { ...base, lane: PullRequestCommentLane.REVIEWS, itemCount: 1 },
      ]);
    });
  });

  it("records a list stopped at its ceiling as CEILING and one that shifted as SHIFTED", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();

      const result = await reconcile(
        scope,
        lists({
          issueComments: list([providerIssueComment(1)], false),
          reviewComments: {
            status: GitHubProviderResultStatus.Success,
            value: { items: [], complete: false, shifted: true },
          },
        })
      );

      expect(result.status).toBe(GitHubCommentReconcileStatus.Partial);
      expect(
        (await proofRows(scope)).map((row) => [
          row.lane,
          row.status,
          row.itemCount,
          row.retractedCount,
          row.lastCompleteListedAt,
          row.incompleteStreak,
        ])
      ).toEqual([
        [
          PullRequestCommentLane.ISSUE_COMMENTS,
          PullRequestCommentLaneStatus.CEILING,
          1,
          null,
          null,
          1,
        ],
        [
          PullRequestCommentLane.REVIEW_COMMENTS,
          PullRequestCommentLaneStatus.SHIFTED,
          0,
          null,
          null,
          1,
        ],
        [
          PullRequestCommentLane.REVIEWS,
          PullRequestCommentLaneStatus.COMPLETE,
          0,
          0,
          expect.any(Date),
          0,
        ],
      ]);
    });
  });

  it("records a lane the provider failed as FAILED with its own status, and its siblings by their own result", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();

      await reconcile(
        scope,
        lists({
          issueComments: list([providerIssueComment(1)]),
          reviewComments: {
            status: GitHubProviderResultStatus.ProviderRateLimit,
            retryAfterSeconds: null,
          },
          reviews: list([], false),
        })
      );

      expect(
        (await proofRows(scope)).map((row) => [
          row.lane,
          row.status,
          row.errorCode,
          row.itemCount,
        ])
      ).toEqual([
        [
          PullRequestCommentLane.ISSUE_COMMENTS,
          PullRequestCommentLaneStatus.COMPLETE,
          null,
          1,
        ],
        [
          PullRequestCommentLane.REVIEW_COMMENTS,
          PullRequestCommentLaneStatus.FAILED,
          GitHubProviderResultStatus.ProviderRateLimit,
          null,
        ],
        [
          PullRequestCommentLane.REVIEWS,
          PullRequestCommentLaneStatus.CEILING,
          null,
          0,
        ],
      ]);
    });
  });

  it("records every lane FAILED with the provider status, at the read's time, when every list failed", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      const read = lists({
        issueComments: FAILED,
        reviewComments: FAILED,
        reviews: FAILED,
      });

      await reconcile(scope, read);

      expect(
        (await proofRows(scope)).map((row) => [
          row.status,
          row.errorCode,
          row.listedAt,
        ])
      ).toEqual(
        Array.from({ length: 3 }, () => [
          PullRequestCommentLaneStatus.FAILED,
          GitHubProviderResultStatus.ProviderUnavailable,
          read.listedAt,
        ])
      );
    });
  });

  it("records every lane FAILED with the credential's code when no credential could read the lists", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      mocks.getGitHubSyncClient.mockResolvedValue({
        ok: false,
        error: { reason: GitHubAccessDenialReason.NoInstallation },
      });

      await reconcile(scope);

      const rows = await proofRows(scope);
      expect(rows.map((row) => [row.status, row.errorCode])).toEqual(
        Array.from({ length: 3 }, () => [
          PullRequestCommentLaneStatus.FAILED,
          GitHubAccessDenialReason.NoInstallation,
        ])
      );
      expect(rows.every((row) => row.listedAt instanceof Date)).toBe(true);
    });
  });

  it("records every lane FAILED when the apply throws, a provider-failed lane with its own status, at the read's time, and rethrows", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      mocks.applyFails = true;
      const read = lists({
        issueComments: list([providerIssueComment(1)]),
        reviewComments: {
          status: GitHubProviderResultStatus.ProviderRateLimit,
          retryAfterSeconds: null,
        },
      });

      await expect(reconcile(scope, read)).rejects.toThrow(
        APPLY_FAILURE_MESSAGE
      );

      expect(
        (await proofRows(scope)).map((row) => [
          row.lane,
          row.status,
          row.errorCode,
          row.listedAt,
        ])
      ).toEqual([
        [
          PullRequestCommentLane.ISSUE_COMMENTS,
          PullRequestCommentLaneStatus.FAILED,
          AcquisitionFailureCode.ApplyFailed,
          read.listedAt,
        ],
        [
          PullRequestCommentLane.REVIEW_COMMENTS,
          PullRequestCommentLaneStatus.FAILED,
          GitHubProviderResultStatus.ProviderRateLimit,
          read.listedAt,
        ],
        [
          PullRequestCommentLane.REVIEWS,
          PullRequestCommentLaneStatus.FAILED,
          AcquisitionFailureCode.ApplyFailed,
          read.listedAt,
        ],
      ]);
    });
  });

  it("records every lane FAILED as read_failed when reading the lists throws, and rethrows", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      mocks.getGitHubSyncClient.mockRejectedValue(
        new Error(READ_FAILURE_MESSAGE)
      );

      await expect(reconcile(scope)).rejects.toThrow(READ_FAILURE_MESSAGE);

      expect(
        (await proofRows(scope)).map((row) => [row.status, row.errorCode])
      ).toEqual(
        Array.from({ length: 3 }, () => [
          PullRequestCommentLaneStatus.FAILED,
          AcquisitionFailureCode.ReadFailed,
        ])
      );
    });
  });

  it("counts failed attempts and keeps the last complete observation until the next complete one", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      const first = lists();
      await reconcile(scope, first);
      const lane = PullRequestCommentLane.ISSUE_COMMENTS;

      const observed: unknown[] = [];
      for (const read of [
        lists({ issueComments: FAILED }),
        lists({ issueComments: FAILED }),
      ]) {
        await reconcile(scope, read);
        observed.push(await laneRow(scope, lane));
      }
      const last = lists();
      await reconcile(scope, last);
      observed.push(await laneRow(scope, lane));

      expect(observed).toEqual([
        expect.objectContaining({
          generation: 2,
          status: PullRequestCommentLaneStatus.FAILED,
          incompleteStreak: 1,
          lastCompleteListedAt: first.listedAt,
        }),
        expect.objectContaining({
          generation: 3,
          status: PullRequestCommentLaneStatus.FAILED,
          incompleteStreak: 2,
          lastCompleteListedAt: first.listedAt,
        }),
        expect.objectContaining({
          generation: 4,
          status: PullRequestCommentLaneStatus.COMPLETE,
          incompleteStreak: 0,
          lastCompleteListedAt: last.listedAt,
        }),
      ]);
    });
  });

  it("records how many comments a complete list's cleanup retracted", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      await applyExternal(
        applyInput(scope, [issueCommentEvent(9999), issueCommentEvent(1)])
      );

      await reconcile(
        scope,
        lists({ issueComments: list([providerIssueComment(1)]) })
      );

      expect(
        await laneRow(scope, PullRequestCommentLane.ISSUE_COMMENTS)
      ).toEqual(
        expect.objectContaining({
          status: PullRequestCommentLaneStatus.COMPLETE,
          retractedCount: 1,
        })
      );
      expect(
        (await storedComment(scope, 9999))?.comment.deletedAt
      ).not.toBeNull();
    });
  });

  it("records proof for a run that holds its lease, and none for one whose lease was taken over", async () => {
    await joinAmbientTransaction(async () => {
      const fresh = await seed();
      mockFetchedLists();
      await reconcile(fresh);
      expect(await proofRows(fresh)).toHaveLength(3);

      const overtaken = await seed();
      mockFetchedLists(list([]), async () => {
        await withDb((db) =>
          db.pullRequestDetail.update({
            where: { id: overtaken.pullRequestDetailId },
            data: { commentsReconcileClaimedAt: new Date(Date.now() + 60_000) },
          })
        );
      });

      await reconcile(overtaken);

      expect(await proofRows(overtaken)).toEqual([]);
    });
  });

  it("records nothing when another run holds the lease", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      await withDb((db) =>
        db.pullRequestDetail.update({
          where: { id: scope.pullRequestDetailId },
          data: { commentsReconcileClaimedAt: new Date() },
        })
      );

      const result = await reconcile(scope, lists());

      expect(result.status).toBe(GitHubCommentReconcileStatus.Claimed);
      expect(await proofRows(scope)).toEqual([]);
    });
  });
});
