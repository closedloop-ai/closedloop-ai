import {
  BranchCommentsBudget,
  type BranchCommentsFailureReason,
  type BranchCommentsState,
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";

/**
 * Build a comment-less `BranchPrCommentsResponse` carrying an explicit state.
 *
 * The desktop LOCAL branches data source has no provider to read PR comments
 * from, so it answers with this shape rather than an empty array that would read
 * as "this PR has no comments" — the state field is what distinguishes
 * unavailable from a real zero.
 *
 * PLN-1535 M5.3: this module used to also host `fetchLivePrComments`, the
 * `/api/gateway/git/pr/comments` client. That live half lost its last caller
 * when FEA-2608 moved Branches comments onto the persisted cloud projection, and
 * it went with the rest of the live-overlay lane; only the builder below is
 * reachable, so the module is no longer a "live overlay" at all.
 */
export function buildLocalCommentsResponse({
  branchId,
  state,
  prNumber,
  prUrl,
  failureReason,
}: {
  branchId: string;
  state: BranchCommentsState;
  prNumber: number | null;
  prUrl: string | null;
  failureReason?: BranchCommentsFailureReason;
}): BranchPrCommentsResponse {
  const response: BranchPrCommentsResponse = {
    branchId,
    state,
    comments: [],
    budget: {
      maxComments: BranchCommentsBudget.MaxComments,
      pageSize: BranchCommentsBudget.PageSize,
      maxBodyBytes: BranchCommentsBudget.MaxBodyBytes,
      maxResponseBytes: BranchCommentsBudget.MaxResponseBytes,
      providerTruncated: false,
      responseTruncated: false,
      omittedComments: 0,
      bodyTruncatedCount: 0,
    },
    providerProofedAt: null,
    stale: false,
    mixedProjection: false,
    prNumber,
    prUrl,
  };
  if (failureReason) {
    response.failureReason = failureReason;
  }
  return response;
}
