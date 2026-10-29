import { StatusCheckRollupFailureReason } from "@repo/api/src/types/github-status";
import { GitHubCommentThreadKind } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  existingPullRequest,
  existingReviewThreadProjectionRow,
  pullRequestMetadata,
  readModelPullRequest,
} from "@/__tests__/support/integrations/github/backfill-projection-writer.test-fixtures";
import type {
  GitHubBackfillProjectionScope,
  GitHubBackfillPullRequestMetadata,
} from "./backfill-projection-contract";
import {
  addMetadataDiff,
  emptyProjectionDiff,
  incrementIncomingMetadataBlastRadius,
  pullRequestProjectionWouldChange,
} from "./backfill-projection-diff-counter";

/**
 * ISS-11280: the dry-run counter branches the writer-level diff suite
 * (`backfill-projection-diff.test.ts`) does not reach — the absent-metadata and
 * absent-head short-circuits, a complete read that returned zero comments,
 * soft-deleted and drifted comment rows, and unparseable provider timestamps.
 * Driven through the module's exports against a stub transaction so each
 * query's exact predicate is observable.
 */

const commentFindManyMock = vi.fn();
const threadFindManyMock = vi.fn();
const reviewFindManyMock = vi.fn();
const statusCheckFindManyMock = vi.fn();
const tx = {
  gitHubCommentProjection: { findMany: commentFindManyMock },
  gitHubCommentThreadProjection: { findMany: threadFindManyMock },
  gitHubPRReview: { findMany: reviewFindManyMock },
  branchStatusCheck: { findMany: statusCheckFindManyMock },
};

const SCOPE: GitHubBackfillProjectionScope = {
  organizationId: "org-1",
  repositoryId: "repo-1",
  branchArtifactId: "branch-artifact-1",
  pullRequestDetailId: "pr-detail-1",
  pullNumber: 42,
  headSha: "abc123",
};

const ISSUE_COMMENT_URL =
  "https://github.com/closedloop-ai/closedloop-ai/pull/42#issuecomment-1001";
const ISSUE_COMMENT_UPDATED_AT = "2026-07-05T00:01:00.000Z";

describe("addMetadataDiff", () => {
  beforeEach(() => {
    commentFindManyMock.mockResolvedValue([]);
    threadFindManyMock.mockResolvedValue([]);
    reviewFindManyMock.mockResolvedValue([]);
    statusCheckFindManyMock.mockResolvedValue([]);
  });

  it("leaves the diff untouched and reads nothing when the PR has no metadata", async () => {
    const diff = emptyProjectionDiff();

    await addMetadataDiff(tx as never, diff, SCOPE, undefined);

    expect(diff).toEqual(emptyProjectionDiff());
    expect(commentFindManyMock).not.toHaveBeenCalled();
    expect(threadFindManyMock).not.toHaveBeenCalled();
    expect(reviewFindManyMock).not.toHaveBeenCalled();
    expect(statusCheckFindManyMock).not.toHaveBeenCalled();
  });

  it("counts only stale rows when a complete comment read returned no comments", async () => {
    commentFindManyMock.mockResolvedValue([
      { commentId: "stale-1" },
      { commentId: "stale-2" },
    ]);
    const diff = emptyProjectionDiff();

    await addMetadataDiff(
      tx as never,
      diff,
      SCOPE,
      emptyMetadata({ issueCommentsComplete: true })
    );

    expect(diff.issueCommentProjectionChangeCount).toBe(2);
    // No live ids means no existing-row read — only the stale sweep, and its
    // id predicate drops the `notIn` arm entirely.
    expect(commentFindManyMock).toHaveBeenCalledTimes(1);
    expect(commentFindManyMock).toHaveBeenCalledWith({
      where: {
        githubCommentId: { not: null },
        githubDeletedAt: null,
        threadProjection: {
          branchArtifactId: SCOPE.branchArtifactId,
          pullRequestDetailId: SCOPE.pullRequestDetailId,
          threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
        },
        comment: { deletedAt: null },
      },
      select: { commentId: true },
    });
  });

  // One row per case: in a mixed batch, flipping either the deleted check or
  // the url check trades one miscount for another and the total stays equal.
  it.each([
    { name: "a matching row", row: persistedIssueComment("1"), expected: 0 },
    {
      name: "a soft-deleted row",
      row: persistedIssueComment("1", {
        githubDeletedAt: new Date("2026-07-06T00:00:00.000Z"),
      }),
      expected: 1,
    },
    {
      name: "a row whose url drifted but whose timestamp matches",
      row: persistedIssueComment("1", { githubHtmlUrl: "https://moved" }),
      expected: 1,
    },
    {
      name: "a row whose timestamp drifted but whose url matches",
      row: persistedIssueComment("1", {
        githubUpdatedAt: new Date("2026-07-04T00:00:00.000Z"),
      }),
      expected: 1,
    },
  ])("counts $expected change(s) for $name", async ({ row, expected }) => {
    commentFindManyMock.mockResolvedValue([row]);
    const diff = emptyProjectionDiff();

    await addMetadataDiff(
      tx as never,
      diff,
      SCOPE,
      emptyMetadata({ issueComments: [issueComment("1")] })
    );

    expect(diff.issueCommentProjectionChangeCount).toBe(expected);
  });

  it("reads persisted rows by live id and skips the stale sweep when the read is incomplete", async () => {
    commentFindManyMock.mockResolvedValue([]);
    const diff = emptyProjectionDiff();

    await addMetadataDiff(
      tx as never,
      diff,
      SCOPE,
      emptyMetadata({
        issueComments: ["1", "2"].map((id) => issueComment(id)),
        issueCommentsComplete: false,
      })
    );

    // Neither id is persisted, so both are inserts.
    expect(diff.issueCommentProjectionChangeCount).toBe(2);
    // An incomplete read cannot prove absence, so no stale sweep is issued.
    expect(commentFindManyMock).toHaveBeenCalledTimes(1);
    // pins current behavior; looks odd because apps/api/AGENTS.md asks
    // provider-identity lookups to scope through the organization, and this
    // predicate carries no organizationId — the branch artifact and PR detail
    // ids are its only tenant anchor. Tracked in ISS-11318.
    expect(commentFindManyMock).toHaveBeenCalledWith({
      where: {
        githubCommentId: { in: ["1", "2"] },
        threadProjection: {
          branchArtifactId: SCOPE.branchArtifactId,
          pullRequestDetailId: SCOPE.pullRequestDetailId,
          threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
        },
      },
      select: {
        githubCommentId: true,
        githubHtmlUrl: true,
        githubUpdatedAt: true,
        githubDeletedAt: true,
      },
    });
  });

  it("excludes the live comment ids from the stale sweep of a complete read", async () => {
    commentFindManyMock.mockImplementation(
      (query: { where: { githubCommentId: Record<string, unknown> } }) =>
        Promise.resolve(
          "in" in query.where.githubCommentId
            ? [persistedIssueComment("1"), persistedIssueComment("2")]
            : [{ commentId: "stale-9" }]
        )
    );
    const diff = emptyProjectionDiff();

    await addMetadataDiff(
      tx as never,
      diff,
      SCOPE,
      emptyMetadata({
        issueComments: ["1", "2"].map((id) => issueComment(id)),
        issueCommentsComplete: true,
      })
    );

    // Both live rows match, so the only change is the one stale row.
    expect(diff.issueCommentProjectionChangeCount).toBe(1);
    expect(commentFindManyMock).toHaveBeenCalledTimes(2);
    expect(commentFindManyMock).toHaveBeenLastCalledWith({
      where: {
        githubCommentId: { notIn: ["1", "2"], not: null },
        githubDeletedAt: null,
        threadProjection: {
          branchArtifactId: SCOPE.branchArtifactId,
          pullRequestDetailId: SCOPE.pullRequestDetailId,
          threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
        },
        comment: { deletedAt: null },
      },
      select: { commentId: true },
    });
  });

  it("counts an unparseable provider updated_at as drift", async () => {
    commentFindManyMock.mockResolvedValue([persistedIssueComment("1")]);
    const diff = emptyProjectionDiff();

    await addMetadataDiff(
      tx as never,
      diff,
      SCOPE,
      emptyMetadata({
        issueComments: [issueComment("1", { updated_at: "not-a-date" })],
      })
    );

    // The raw string is compared as-is rather than thrown on.
    expect(diff.issueCommentProjectionChangeCount).toBe(1);
  });

  it("compares a thread with replies against its root comment, as the reconcile writes it", async () => {
    threadFindManyMock.mockResolvedValue([existingReviewThreadProjectionRow()]);
    const [root] = pullRequestMetadata().reviewComments;
    if (!root) {
      throw new Error("expected the fixture review comment");
    }
    const reply = {
      ...root,
      id: 2002,
      node_id: "review-node-2002",
      in_reply_to_id: root.id,
      pull_request_review_id: 3002,
      created_at: "2026-07-05T00:05:00.000Z",
      html_url:
        "https://github.com/closedloop-ai/closedloop-ai/pull/42#discussion_r2002",
    };
    const diff = emptyProjectionDiff();

    await addMetadataDiff(
      tx as never,
      diff,
      SCOPE,
      emptyMetadata({ reviewComments: [root, reply] })
    );

    expect(diff.reviewThreadProjectionChangeCount).toBe(0);
  });

  it("does not match a persisted thread row that carries neither identity", async () => {
    threadFindManyMock.mockResolvedValue([
      existingReviewThreadProjectionRow({
        reviewThreadId: null,
        rootCommentId: null,
      }),
    ]);
    const diff = emptyProjectionDiff();

    await addMetadataDiff(
      tx as never,
      diff,
      SCOPE,
      emptyMetadata({ reviewComments: pullRequestMetadata().reviewComments })
    );

    expect(diff.reviewThreadProjectionChangeCount).toBe(1);
    expect(threadFindManyMock).toHaveBeenCalledWith({
      where: {
        branchArtifactId: SCOPE.branchArtifactId,
        pullRequestDetailId: SCOPE.pullRequestDetailId,
        threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
        OR: [
          { reviewThreadId: { in: ["thread-node-2001"] } },
          { rootCommentId: { in: ["2001"] } },
        ],
      },
      select: {
        reviewThreadId: true,
        rootCommentId: true,
        reviewId: true,
        path: true,
        line: true,
        originalLine: true,
        side: true,
        startLine: true,
        startSide: true,
        commitSha: true,
        htmlUrl: true,
        legacyState: true,
        deletedAt: true,
      },
    });
  });

  it("counts no status-check change and reads nothing when the PR has no head SHA", async () => {
    const diff = emptyProjectionDiff();

    await addMetadataDiff(
      tx as never,
      diff,
      { ...SCOPE, headSha: null },
      emptyMetadata({
        statusCheckRollup: pullRequestMetadata().statusCheckRollup,
      })
    );

    expect(diff.statusCheckProjectionChangeCount).toBe(0);
    expect(statusCheckFindManyMock).not.toHaveBeenCalled();
  });

  it("counts no status-check change when the rollup is absent", async () => {
    const diff = emptyProjectionDiff();

    await addMetadataDiff(tx as never, diff, SCOPE, emptyMetadata());

    expect(diff.statusCheckProjectionChangeCount).toBe(0);
    expect(statusCheckFindManyMock).not.toHaveBeenCalled();
  });

  it("counts a failed rollup as one change without reading persisted checks", async () => {
    const diff = emptyProjectionDiff();

    await addMetadataDiff(
      tx as never,
      diff,
      SCOPE,
      emptyMetadata({
        statusCheckRollup: {
          ok: false,
          reason: StatusCheckRollupFailureReason.RateLimited,
        },
      })
    );

    expect(diff.statusCheckProjectionChangeCount).toBe(1);
    expect(statusCheckFindManyMock).not.toHaveBeenCalled();
  });
});

describe("incrementIncomingMetadataBlastRadius", () => {
  it("counts every incoming row and no status checks when the rollup is absent", () => {
    const diff = emptyProjectionDiff();

    incrementIncomingMetadataBlastRadius(diff, {
      ...pullRequestMetadata(),
      statusCheckRollup: null,
    });

    expect(diff).toEqual({
      ...emptyProjectionDiff(),
      issueCommentProjectionChangeCount: 1,
      reviewCommentProjectionChangeCount: 1,
      reviewThreadProjectionChangeCount: 1,
      reviewProjectionChangeCount: 1,
      statusCheckProjectionChangeCount: 0,
    });
  });

  it("counts a failed rollup as one status-check row", () => {
    const diff = emptyProjectionDiff();

    incrementIncomingMetadataBlastRadius(diff, {
      ...pullRequestMetadata(),
      statusCheckRollup: {
        ok: false,
        reason: StatusCheckRollupFailureReason.PermissionDenied,
      },
    });

    expect(diff.statusCheckProjectionChangeCount).toBe(1);
  });
});

describe("pullRequestProjectionWouldChange", () => {
  it("reports no change for a fully reconciled PR", () => {
    expect(
      pullRequestProjectionWouldChange(
        existingPullRequest(),
        readModelPullRequest()
      )
    ).toBe(false);
  });

  it("compares an unparseable openedAt as its raw string instead of throwing", () => {
    // pins current behavior; looks odd because a garbled provider timestamp
    // can never equal a stored Date, so this PR re-projects on every pass.
    expect(
      pullRequestProjectionWouldChange(
        { ...existingPullRequest(), githubCreatedAt: null },
        { ...readModelPullRequest(), openedAt: "not-a-date" }
      )
    ).toBe(true);
  });
});

function emptyMetadata(
  over: Partial<GitHubBackfillPullRequestMetadata> = {}
): GitHubBackfillPullRequestMetadata {
  return {
    number: 42,
    issueComments: [],
    issueCommentsComplete: false,
    reviewComments: [],
    reviewCommentsComplete: false,
    reviews: [],
    statusCheckRollup: null,
    ...over,
  };
}

function issueComment(
  id: string,
  over: { updated_at?: string } = {}
): GitHubBackfillPullRequestMetadata["issueComments"][number] {
  const [base] = pullRequestMetadata().issueComments;
  if (!base) {
    throw new Error("fixture metadata has no issue comment");
  }
  return { ...base, id: Number(id), ...over };
}

function persistedIssueComment(
  githubCommentId: string,
  over: {
    githubHtmlUrl?: string;
    githubUpdatedAt?: Date;
    githubDeletedAt?: Date | null;
  } = {}
) {
  return {
    githubCommentId,
    githubHtmlUrl: ISSUE_COMMENT_URL,
    githubUpdatedAt: new Date(ISSUE_COMMENT_UPDATED_AT),
    githubDeletedAt: null,
    ...over,
  };
}
