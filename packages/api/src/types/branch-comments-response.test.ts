import { describe, expect, it } from "vitest";
import {
  BranchCommentsBudget,
  BranchCommentsState,
  type BranchPrCommentsResponse,
} from "./branch";
import { fitBranchPrCommentsResponseBudget } from "./branch-comments-budget";

describe("BranchPrCommentsResponse", () => {
  it("preserves additive repository identity through response budgeting", () => {
    const response: BranchPrCommentsResponse = {
      branchId: "branch-1",
      repositoryFullName: "closedloop-ai/closedloop-ai",
      state: BranchCommentsState.SyncedEmpty,
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
      prNumber: 17,
      prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/17",
    };

    expect(fitBranchPrCommentsResponseBudget(response)).toMatchObject({
      repositoryFullName: "closedloop-ai/closedloop-ai",
      prNumber: 17,
    });
  });

  it("keeps repository identity omitted for legacy producers", () => {
    const response = commentsResponse();

    expect(fitBranchPrCommentsResponseBudget(response)).not.toHaveProperty(
      "repositoryFullName"
    );
  });
});

function commentsResponse(): BranchPrCommentsResponse {
  return {
    branchId: "branch-1",
    state: BranchCommentsState.SyncedEmpty,
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
    prNumber: 17,
    prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/17",
  };
}
