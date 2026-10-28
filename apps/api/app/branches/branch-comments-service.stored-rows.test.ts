import {
  BranchCommentsBudget,
  BranchCommentsFailureReason,
  BranchCommentsState,
} from "@repo/api/src/types/branch";
import { CommentSyncStatus } from "@repo/api/src/types/comment-thread-dto";
import { GitHubProviderResultStatus } from "@repo/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_ID,
  branchContextRow,
  projectionRow,
  RECONCILED_AT,
  reconcileMarker,
  reconcileResult,
  unsyncedMarker,
} from "@/__tests__/support/branches/branch-comments-service.test-helpers";
import { GitHubCommentReconcileStatus } from "../comments/service/github/github-comment-reconcile";

const WRITE_AFFORDANCE_KEYS_REGEX =
  /canReply|viewerCan|action|mutation|replyUrl|editUrl|deleteUrl|resolveUrl|capabilityContext/;

const mocks = vi.hoisted(() => ({
  artifactFindFirst: vi.fn(),
  commentFindMany: vi.fn(),
  repositoryFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  readMarker: vi.fn(),
  reconcileOnView: vi.fn(),
  withDb: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: mocks.withDb,
}));

vi.mock(
  "@/app/comments/service/github/github-comment-reconcile-marker",
  () => ({ readPullRequestCommentsReconcileMarker: mocks.readMarker })
);

vi.mock(
  "@/app/comments/service/github/github-comment-on-demand-reconcile",
  () => ({ reconcilePullRequestCommentsOnView: mocks.reconcileOnView })
);

import { branchCommentsService } from "./branch-comments-service";

/** PLN-2122 Step 6: the stored rows, their freshness and the first-view reconcile. */
describe("branchCommentsService stored rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        artifact: { findFirst: mocks.artifactFindFirst },
        comment: { findMany: mocks.commentFindMany },
        gitHubInstallationRepository: {
          findFirst: mocks.repositoryFindFirst,
        },
        $queryRaw: mocks.queryRaw,
      })
    );
    mocks.artifactFindFirst.mockResolvedValue(branchContextRow());
    mocks.commentFindMany.mockResolvedValue([]);
    mocks.queryRaw.mockResolvedValue([{ id: BRANCH_ID }]);
    mocks.readMarker.mockResolvedValue(reconcileMarker());
    mocks.reconcileOnView.mockResolvedValue(reconcileResult());
  });

  describe("freshness (Kerensa, 2026-10-05)", () => {
    it("does not mark a comment stale for its projection's sync time once its PR is reconciled", async () => {
      mocks.commentFindMany.mockResolvedValue([
        projectionRow({ id: "no-sync-state" }),
        projectionRow({
          id: "synced",
          syncStates: [CommentSyncStatus.Synced],
        }),
      ]);

      const result = await getComments();

      expect(result).toMatchObject({
        state: BranchCommentsState.Populated,
        stale: false,
        mixedProjection: false,
        providerProofedAt: null,
      });
      expect(result?.comments.map((comment) => comment.stale)).toEqual([
        false,
        false,
      ]);
    });

    it("marks only a comment with an unconfirmed GitHub sync state stale", async () => {
      mocks.commentFindMany.mockResolvedValue([
        projectionRow({ id: "failed", syncStates: [CommentSyncStatus.Failed] }),
        projectionRow({ id: "confirmed" }),
      ]);

      const result = await getComments();

      expect(result).toMatchObject({
        state: BranchCommentsState.StaleMixed,
        stale: true,
        mixedProjection: true,
      });
      expect(result?.comments.map(({ id, stale }) => ({ id, stale }))).toEqual([
        { id: "failed", stale: true },
        { id: "confirmed", stale: false },
      ]);
    });

    it("marks every comment stale when the pull request's latest reconcile attempt failed", async () => {
      mocks.readMarker.mockResolvedValue(
        reconcileMarker({ latestAttemptFailed: true })
      );
      mocks.commentFindMany.mockResolvedValue([
        projectionRow({ id: "a" }),
        projectionRow({ id: "b", syncStates: [CommentSyncStatus.Synced] }),
      ]);

      const result = await getComments();

      expect(result?.state).toBe(BranchCommentsState.StaleMixed);
      expect(result?.comments.every((comment) => comment.stale)).toBe(true);
    });
  });

  it("preserves simultaneous stale and body-truncated evidence with an exact aggregate count", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({
        plainText: "x".repeat(BranchCommentsBudget.MaxBodyBytes + 1),
        syncStates: [CommentSyncStatus.Pending],
      }),
    ]);

    const result = await getComments();

    expect(result).toMatchObject({
      budget: { bodyTruncatedCount: 1 },
      mixedProjection: true,
      stale: true,
      state: BranchCommentsState.StaleMixed,
    });
    expect(result?.comments[0]).toMatchObject({
      bodyTruncated: true,
      stale: true,
    });
  });

  it("returns SyncedEmpty proofed at the last complete reconcile, without reconciling again", async () => {
    const result = await getComments();

    expect(result).toMatchObject({
      state: BranchCommentsState.SyncedEmpty,
      providerProofedAt: RECONCILED_AT.toISOString(),
      stale: false,
      comments: [],
    });
    expect(mocks.readMarker).toHaveBeenCalledWith("org-1", "pr-detail-1");
    expect(mocks.reconcileOnView).not.toHaveBeenCalled();
  });

  it("returns SyncedEmpty as stale when an attempt after the last complete reconcile failed", async () => {
    mocks.readMarker.mockResolvedValue(
      reconcileMarker({ latestAttemptFailed: true })
    );

    const result = await getComments();

    expect(result).toMatchObject({
      state: BranchCommentsState.SyncedEmpty,
      providerProofedAt: RECONCILED_AT.toISOString(),
      stale: true,
      comments: [],
    });
  });

  it("reconciles an unsynced pull request on first view and serves the rows it stored", async () => {
    mocks.readMarker
      .mockResolvedValueOnce(unsyncedMarker())
      .mockResolvedValueOnce(reconcileMarker());
    mocks.commentFindMany.mockResolvedValue([projectionRow()]);

    const result = await getComments();

    expect(mocks.reconcileOnView).toHaveBeenCalledWith("pr-detail-1");
    expect(mocks.reconcileOnView.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.commentFindMany.mock.invocationCallOrder[0] ?? 0
    );
    expect(result).toMatchObject({
      state: BranchCommentsState.Populated,
      stale: false,
    });
    expect(result?.comments).toHaveLength(1);
  });

  it("folds a failed first-view reconcile into ProviderError when nothing is stored", async () => {
    mocks.readMarker.mockResolvedValue(
      unsyncedMarker({ latestAttemptFailed: true })
    );
    mocks.reconcileOnView.mockResolvedValue(
      reconcileResult(
        GitHubCommentReconcileStatus.ProviderError,
        GitHubProviderResultStatus.ProviderUnavailable
      )
    );

    const result = await getComments();

    expect(result).toMatchObject({
      state: BranchCommentsState.ProviderError,
      failureReason: BranchCommentsFailureReason.ProviderUnavailable,
      comments: [],
      providerProofedAt: expect.any(String),
      stale: false,
    });
  });

  it("marks count-budget truncation of stored rows with the over-limit state", async () => {
    mocks.commentFindMany.mockResolvedValue(
      Array.from({ length: BranchCommentsBudget.MaxComments + 1 }, (_, index) =>
        projectionRow({ id: `comment-${index}` })
      )
    );

    const result = await getComments();

    expect(result?.state).toBe(BranchCommentsState.OverLimitTruncated);
    expect(result?.comments).toHaveLength(BranchCommentsBudget.MaxComments);
    expect(result?.budget).toMatchObject({
      providerTruncated: true,
      omittedComments: 1,
    });
    expect(mocks.commentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: BranchCommentsBudget.MaxComments + 1 })
    );
  });

  it("returns a read-only comments DTO key set", async () => {
    mocks.commentFindMany.mockResolvedValue([projectionRow()]);

    const result = await getComments();

    expect(Object.keys(result ?? {}).sort()).toEqual([
      "branchId",
      "budget",
      "comments",
      "mixedProjection",
      "prNumber",
      "prUrl",
      "providerProofedAt",
      "repositoryFullName",
      "stale",
      "state",
    ]);
    expect(Object.keys(result?.comments[0] ?? {}).sort()).toEqual([
      "author",
      "body",
      "bodyTruncated",
      "createdAt",
      "id",
      "inReplyToId",
      "kind",
      "line",
      "path",
      "providerCommentId",
      "providerNodeId",
      "providerUrl",
      "resolved",
      "stale",
      "threadId",
      "updatedAt",
    ]);
    expect(JSON.stringify(result)).not.toMatch(WRITE_AFFORDANCE_KEYS_REGEX);
  });
});

function getComments() {
  return branchCommentsService.getBranchComments("org-1", BRANCH_ID);
}
