import {
  BranchCommentsFailureReason,
  BranchCommentsState,
} from "@repo/api/src/types/branch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLivePrComments } from "../live-pr-comments";

const LIVE_COMMENTS_IDENTITY = {
  owner: "closedloop-ai",
  repo: "symphony-alpha",
  prNumber: 42,
  branchId: "closedloop-ai/symphony-alpha:branch-1",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLivePrComments", () => {
  it("maps desktop branch-scope 403 responses to forbidden mismatch comments state", async () => {
    stubFetchResponse(
      403,
      {
        error: "branch scope does not match pull request",
        reason: BranchCommentsFailureReason.ForbiddenMismatch,
      },
      false
    );

    const result = await fetchLivePrComments(LIVE_COMMENTS_IDENTITY);

    expect(result).toMatchObject({
      branchId: LIVE_COMMENTS_IDENTITY.branchId,
      state: BranchCommentsState.ForbiddenMismatch,
      prNumber: LIVE_COMMENTS_IDENTITY.prNumber,
      comments: [],
    });
  });

  it.each([
    BranchCommentsFailureReason.Auth,
    BranchCommentsFailureReason.RateLimit,
    BranchCommentsFailureReason.SecondaryLimit,
    BranchCommentsFailureReason.Timeout,
  ])("preserves desktop provider failure reason %s", async (reason) => {
    stubFetchResponse(503, { error: "provider failed", reason }, false);

    const result = await fetchLivePrComments(LIVE_COMMENTS_IDENTITY);

    expect(result).toMatchObject({
      branchId: LIVE_COMMENTS_IDENTITY.branchId,
      state: BranchCommentsState.ProviderError,
      failureReason: reason,
      prNumber: LIVE_COMMENTS_IDENTITY.prNumber,
      comments: [],
    });
  });
});

function stubFetchResponse(
  status: number,
  body: Record<string, unknown>,
  ok: boolean
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(body),
    })
  );
}
