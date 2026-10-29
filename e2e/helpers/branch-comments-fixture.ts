import {
  BranchCommentsBudget,
  BranchCommentsState,
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";

/**
 * The empty-but-SYNCED `GET /branches/<id>/comments` payload — a branch whose PR
 * comments were fetched successfully and there simply were none.
 *
 * Shared because every spec that renders branch DETAIL has to answer this read
 * (the detail page fans out to it unconditionally) while asserting on something
 * else entirely, and the response is a full budget block rather than a `{}` —
 * so each such spec was otherwise re-deriving eight budget fields it does not
 * care about. `branches-surface.spec.ts` and `activity-phase-fixtures.ts` both
 * consume this; keeping it in one place means a change to
 * {@link BranchPrCommentsResponse} lands in one fixture, not N near-copies that
 * drift apart.
 *
 * Deliberately NOT parameterized beyond identity: a spec that needs actual
 * comments, a failure reason, or a truncated budget is exercising the comments
 * panel itself and should build that payload where the assertion lives.
 */
export function emptySyncedBranchComments(input: {
  branchId: string;
  prNumber: number | null;
  prUrl: string | null;
  providerProofedAt: string | null;
}): BranchPrCommentsResponse {
  return {
    branchId: input.branchId,
    budget: {
      bodyTruncatedCount: 0,
      maxBodyBytes: BranchCommentsBudget.MaxBodyBytes,
      maxComments: BranchCommentsBudget.MaxComments,
      maxResponseBytes: BranchCommentsBudget.MaxResponseBytes,
      omittedComments: 0,
      pageSize: BranchCommentsBudget.PageSize,
      providerTruncated: false,
      responseTruncated: false,
    },
    comments: [],
    mixedProjection: false,
    prNumber: input.prNumber,
    prUrl: input.prUrl,
    providerProofedAt: input.providerProofedAt,
    stale: false,
    state: BranchCommentsState.SyncedEmpty,
  };
}
