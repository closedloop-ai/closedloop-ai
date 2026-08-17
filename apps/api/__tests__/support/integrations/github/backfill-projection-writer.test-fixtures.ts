import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubReadModelSource } from "@repo/api/src/types/github-read-model";
import type { GitHubBackfillPullRequestMetadata } from "@/app/integrations/github/backfill-projection-contract";

/**
 * Shared fixtures for the GitHub backfill projection writer.
 *
 * Extracted (ISS-5291) so the write-path suite and the diff-counter suite build
 * their rows from ONE shape. The counters under test compare an incoming
 * provider payload field-by-field against a persisted row, so two hand-kept
 * copies of these shapes would let a suite pass while comparing against a row
 * the other half of the module never produces.
 *
 * Every factory returns a fresh object: callers mutate them to express drift.
 */

/** A provider read-model PR that matches {@link existingPullRequest} exactly. */
export function readModelPullRequest() {
  return {
    githubId: "4242",
    number: 42,
    title: "Backfilled PR",
    htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
    headBranch: "feature/test",
    baseBranch: "main",
    headSha: "abc123",
    state: GitHubPRState.Open,
    isDraft: false,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: ReviewDecision.Approved,
    checksStatus: ChecksStatus.Passing,
    statusCheckRollup: "SUCCESS",
    openedAt: "2026-07-05T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: "2026-07-05T01:00:00.000Z",
    author: "octocat",
    source: GitHubReadModelSource.Provider,
  };
}

/** The persisted PR row a fully-projected {@link readModelPullRequest} produces. */
export function existingPullRequest() {
  return {
    id: "pr-detail-1",
    githubId: "4242",
    number: 42,
    title: "Backfilled PR",
    htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
    prState: GitHubPRState.Open,
    isDraft: false,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: ReviewDecision.Approved,
    // FEA-3552: a fully-projected existing row carries the GitHub PR createdAt
    // (= the read model's openedAt), so an unchanged re-projection detects no
    // drift on this field.
    githubCreatedAt: new Date("2026-07-05T00:00:00.000Z"),
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
  };
}

export function statusCheckOnlyMetadata(): GitHubBackfillPullRequestMetadata {
  return {
    ...pullRequestMetadata(),
    issueComments: [],
    issueCommentsComplete: false,
    reviewComments: [],
    reviewCommentsComplete: false,
    reviews: [],
  };
}

export function pullRequestMetadata(): GitHubBackfillPullRequestMetadata {
  return {
    number: 42,
    issueComments: [
      {
        id: 1001,
        node_id: "issue-node-1001",
        user: {
          id: 501,
          login: "octocat",
          node_id: "user-node-501",
          avatar_url: "https://avatars.githubusercontent.com/u/501",
        },
        body: "Issue comment",
        author_association: "MEMBER",
        created_at: "2026-07-05T00:00:00.000Z",
        updated_at: "2026-07-05T00:01:00.000Z",
        html_url:
          "https://github.com/closedloop-ai/symphony-alpha/pull/42#issuecomment-1001",
        deleted_at: null,
        is_deleted: false,
        is_updated: true,
      },
    ],
    issueCommentsComplete: true,
    reviewComments: [
      {
        id: 2001,
        node_id: "review-node-2001",
        path: "app.ts",
        line: 10,
        side: "RIGHT",
        start_line: null,
        start_side: null,
        original_line: 10,
        original_start_line: null,
        body: "Review comment",
        user: {
          id: 502,
          login: "reviewer",
          node_id: "user-node-502",
          avatar_url: "https://avatars.githubusercontent.com/u/502",
        },
        author_association: "MEMBER",
        created_at: "2026-07-05T00:02:00.000Z",
        updated_at: "2026-07-05T00:03:00.000Z",
        html_url:
          "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r2001",
        commit_id: "abc123",
        pull_request_review_id: 3001,
        review_thread_node_id: "thread-node-2001",
        review_thread_is_resolved: true,
        in_reply_to_id: null,
        deleted_at: null,
        is_deleted: false,
        is_updated: true,
      },
    ],
    reviewCommentsComplete: true,
    reviews: [
      {
        id: 3001,
        user: {
          login: "reviewer",
          avatar_url: "https://avatars.githubusercontent.com/u/502",
        },
        state: ReviewDecision.Approved,
        body: "Approved",
        submitted_at: "2026-07-05T00:04:00.000Z",
        html_url:
          "https://github.com/closedloop-ai/symphony-alpha/pull/42#pullrequestreview-3001",
      },
    ],
    statusCheckRollup: {
      ok: true,
      state: "SUCCESS",
      checks: [
        {
          id: "check-1",
          providerNodeId: "check-node-1",
          kind: "check_run",
          name: "unit",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          targetUrl: "https://github.com/checks/1",
          position: 0,
        },
      ],
      totalCount: 1,
      truncated: false,
    },
  };
}

/**
 * The persisted comment-thread row that the single fixture review comment
 * projects to — i.e. the row for which `reviewThreadProjectionWouldChange`
 * answers false. Tests express drift by overriding one field.
 */
export function existingReviewThreadProjectionRow(
  over: Record<string, unknown> = {}
) {
  return {
    reviewThreadId: "thread-node-2001",
    rootCommentId: "2001",
    reviewId: "3001",
    path: "app.ts",
    line: 10,
    side: "RIGHT",
    startLine: null,
    startSide: null,
    commitSha: "abc123",
    htmlUrl:
      "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r2001",
    // `review_thread_is_resolved: true` maps to the LEGACY comment state
    // ADDRESSED — not `ThreadStatus.RESOLVED`, which is the other vocabulary
    // this row carries elsewhere.
    legacyState: "ADDRESSED",
    deletedAt: null,
    ...over,
  };
}

/**
 * The persisted review row the single fixture review projects to — the shape
 * `reviewProjectionWouldChange` compares against.
 */
export function existingReviewRow(over: Record<string, unknown> = {}) {
  return {
    authorLogin: "reviewer",
    githubReviewId: "3001",
    authorAvatarUrl: "https://avatars.githubusercontent.com/u/502",
    state: ReviewDecision.Approved,
    body: "Approved",
    htmlUrl:
      "https://github.com/closedloop-ai/symphony-alpha/pull/42#pullrequestreview-3001",
    submittedAt: new Date("2026-07-05T00:04:00.000Z"),
    ...over,
  };
}

/**
 * The persisted per-check row the single fixture rollup check projects to — the
 * shape `statusCheckWouldChange` compares against.
 */
export function existingStatusCheckRow(over: Record<string, unknown> = {}) {
  return {
    // The row is matched to an incoming check by `providerKey` = the check's
    // `id`. Omitting it makes every check read as both an insert and a stale
    // delete, which is a 2x over-count rather than a miss.
    providerKey: "check-1",
    kind: "check_run",
    providerNodeId: "check-node-1",
    name: "unit",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    targetUrl: "https://github.com/checks/1",
    position: 0,
    ...over,
  };
}
