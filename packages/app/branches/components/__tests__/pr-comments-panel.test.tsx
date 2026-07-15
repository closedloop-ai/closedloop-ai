import {
  BranchCommentsFailureReason,
  BranchCommentsState,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PrCommentsPanel } from "../pr-comments-panel";

const WRITE_AFFORDANCE_TEXT_REGEX = /reply|resolve|edit|delete/i;

describe("PrCommentsPanel", () => {
  it.each([
    [
      BranchCommentsState.UnsyncedUnknown,
      "Comments not synced",
      "No synced comment projection or current provider proof is available yet.",
    ],
    [
      BranchCommentsState.ProviderError,
      "Comment provider unavailable",
      "GitHub rate-limited the comments read. Refresh later to retry.",
    ],
    [
      BranchCommentsState.SyncedEmpty,
      "No PR comments",
      "GitHub was checked for this request and returned no comments.",
    ],
    [
      BranchCommentsState.StaleMixed,
      "Comments may be stale",
      "Existing projection rows include legacy freshness evidence, so they are shown conservatively.",
    ],
    [
      BranchCommentsState.OverLimitTruncated,
      "Comment display is truncated",
      "The response exceeded the display budget and was reduced before rendering.",
    ],
    [
      BranchCommentsState.ForbiddenMismatch,
      "Branch and PR do not match",
      "The requested pull request identity does not belong to this branch.",
    ],
  ])("renders %s state copy", (state, title, description) => {
    render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state,
          failureReason:
            state === BranchCommentsState.ProviderError
              ? BranchCommentsFailureReason.RateLimit
              : undefined,
        })}
        isError={false}
        isLoading={false}
      />
    );

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(description)).toBeInTheDocument();
  });

  it("renders populated comments without write affordance text", () => {
    render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state: BranchCommentsState.Populated,
          comments: [
            {
              id: "comment-1",
              providerNodeId: "IC_1",
              providerCommentId: "101",
              kind: BranchPrCommentKind.Issue,
              threadId: null,
              inReplyToId: null,
              path: null,
              line: null,
              resolved: null,
              author: {
                login: "reviewer",
                displayName: null,
                avatarUrl: null,
                profileUrl: null,
              },
              body: "Looks good",
              createdAt: "2026-07-03T12:00:00.000Z",
              updatedAt: "2026-07-03T12:00:00.000Z",
              providerUrl:
                "https://github.com/octo/repo/pull/42#issuecomment-101",
              stale: false,
              bodyTruncated: false,
            },
          ],
        })}
        isError={false}
        isLoading={false}
      />
    );

    expect(screen.getByText("Looks good")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(
      screen.queryByText(WRITE_AFFORDANCE_TEXT_REGEX)
    ).not.toBeInTheDocument();
  });
});

function makeCommentsResponse(
  overrides: Partial<BranchPrCommentsResponse> = {}
): BranchPrCommentsResponse {
  return {
    branchId: "branch-1",
    state: BranchCommentsState.UnsyncedUnknown,
    comments: [],
    budget: {
      maxComments: 100,
      pageSize: 50,
      maxBodyBytes: 16 * 1024,
      maxResponseBytes: 512 * 1024,
      providerTruncated: false,
      responseTruncated: false,
      omittedComments: 0,
      bodyTruncatedCount: 0,
    },
    providerProofedAt: null,
    stale: false,
    mixedProjection: false,
    prNumber: 42,
    prUrl: "https://github.com/octo/repo/pull/42",
    ...overrides,
  };
}
