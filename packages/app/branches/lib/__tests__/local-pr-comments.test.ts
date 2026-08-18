import {
  BranchCommentsBudget,
  BranchCommentsFailureReason,
  BranchCommentsState,
} from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import { buildLocalCommentsResponse } from "../local-pr-comments";

const BRANCH_ID = "closedloop-ai/symphony-alpha:branch-1";

describe("buildLocalCommentsResponse", () => {
  it("carries the unavailable state rather than implying a real zero", () => {
    const response = buildLocalCommentsResponse({
      branchId: BRANCH_ID,
      state: BranchCommentsState.UnsyncedUnknown,
      prNumber: 42,
      prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
    });

    // An empty `comments` array alone would read as "this PR has no comments";
    // the state is what distinguishes unavailable from a genuine zero.
    expect(response.comments).toEqual([]);
    expect(response.state).toBe(BranchCommentsState.UnsyncedUnknown);
    expect(response.branchId).toBe(BRANCH_ID);
    expect(response.prNumber).toBe(42);
  });

  it("omits failureReason entirely when none is supplied", () => {
    const response = buildLocalCommentsResponse({
      branchId: BRANCH_ID,
      state: BranchCommentsState.UnsyncedUnknown,
      prNumber: null,
      prUrl: null,
    });

    expect(response).not.toHaveProperty("failureReason");
  });

  it.each([
    BranchCommentsFailureReason.Auth,
    BranchCommentsFailureReason.RateLimit,
    BranchCommentsFailureReason.SecondaryLimit,
    BranchCommentsFailureReason.Timeout,
  ])("preserves the %s failure reason when supplied", (failureReason) => {
    const response = buildLocalCommentsResponse({
      branchId: BRANCH_ID,
      state: BranchCommentsState.ProviderError,
      prNumber: 42,
      prUrl: null,
      failureReason,
    });

    expect(response.state).toBe(BranchCommentsState.ProviderError);
    expect(response.failureReason).toBe(failureReason);
  });

  it("reports the canonical budget with nothing truncated or omitted", () => {
    const response = buildLocalCommentsResponse({
      branchId: BRANCH_ID,
      state: BranchCommentsState.UnsyncedUnknown,
      prNumber: null,
      prUrl: null,
    });

    expect(response.budget).toEqual({
      maxComments: BranchCommentsBudget.MaxComments,
      pageSize: BranchCommentsBudget.PageSize,
      maxBodyBytes: BranchCommentsBudget.MaxBodyBytes,
      maxResponseBytes: BranchCommentsBudget.MaxResponseBytes,
      providerTruncated: false,
      responseTruncated: false,
      omittedComments: 0,
      bodyTruncatedCount: 0,
    });
    expect(response.stale).toBe(false);
    expect(response.mixedProjection).toBe(false);
    expect(response.providerProofedAt).toBeNull();
  });
});
