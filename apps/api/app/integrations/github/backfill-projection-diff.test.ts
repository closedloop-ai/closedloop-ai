import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { StatusCheckRollupFailureReason } from "@repo/api/src/types/github-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  existingPullRequest,
  existingReviewRow,
  existingReviewThreadProjectionRow,
  existingStatusCheckRow,
  pullRequestMetadata,
  readModelPullRequest,
} from "@/__tests__/support/integrations/github/backfill-projection-writer.test-fixtures";

/**
 * ISS-5291: the DRY-RUN half of the GitHub backfill projection writer.
 *
 * `githubBackfillProjectionWriter.diff()` is what an operator reads before
 * authorizing a backfill: it reports how many rows the write WOULD touch. The
 * write path is covered by `backfill-projection-writer.test.ts`; this file
 * covers the counters, whose whole contract is that the predicted number equals
 * the number of rows the write actually changes.
 *
 * Both failure directions are real and neither is loud. An OVER-count makes a
 * no-op backfill look destructive and gets it cancelled; an UNDER-count — the
 * dangerous one — tells the operator a large rewrite is a handful of rows. So
 * every case below pins a count against a specific persisted-vs-incoming
 * disagreement, and each `*WouldChange` field is driven one at a time: a
 * predicate that dropped a field from its comparison would still return true
 * for the others, and only a per-field case catches it.
 */

const dbMock = {
  branchDetail: { findMany: vi.fn() },
  pullRequestDetail: { findMany: vi.fn() },
};
const txMock = {
  gitHubPRReview: { findMany: vi.fn() },
  gitHubCommentProjection: { findMany: vi.fn() },
  gitHubCommentThreadProjection: { findMany: vi.fn() },
  branchStatusCheck: { findMany: vi.fn() },
};
const withDbMock = Object.assign(
  vi.fn((callback) => callback({ ...dbMock, ...txMock })),
  { tx: vi.fn((callback) => callback(txMock)) }
);

vi.mock("@repo/database", () => ({
  GitHubCommentThreadKind: {
    ISSUE_COMMENT: "ISSUE_COMMENT",
    REVIEW_THREAD: "REVIEW_THREAD",
  },
  GitHubLegacyCommentState: { PENDING: "PENDING", ADDRESSED: "ADDRESSED" },
  ThreadStatus: { OPEN: "OPEN", RESOLVED: "RESOLVED" },
  withDb: withDbMock,
}));

vi.mock("@/lib/branch-status-checks", () => ({
  invalidateBranchStatusChecksForHeadChange: vi.fn(),
  persistBranchStatusChecksFromRollup: vi.fn(),
}));

vi.mock("@/app/comments/external-authors", () => ({
  normalizeExternalGitHubAuthor: (author: { id?: number | null } | null) => ({
    providerUserId: String(author?.id ?? "ghost"),
    isGhost: author?.id == null,
  }),
  resolveExternalGitHubAuthorInTransaction: vi.fn(),
}));

vi.mock("@/app/comments/github-diff-side", () => ({
  normalizeGitHubDiffSide: (side: string | null | undefined) => side ?? null,
}));

vi.mock("@/app/comments/github-projection", () => ({
  softDeleteGitHubCommentProjection: vi.fn(),
  upsertGitHubIssueCommentThread: vi.fn(),
  upsertGitHubReviewCommentThread: vi.fn(),
}));

vi.mock("@/lib/review-decision-utils", () => ({
  recomputeAndUpdateAggregate: vi.fn(),
}));

vi.mock("./pr-review-projection", () => ({
  persistLatestGitHubPRReview: vi.fn(),
}));

const { githubBackfillProjectionWriter } = await import(
  "./backfill-projection-writer"
);

const ORGANIZATION_ID = "org-1";
const REPOSITORY = {
  id: "repo-1",
  fullName: "closedloop-ai/symphony-alpha",
};

/** A branch row already fully reconciled against {@link existingPullRequest}. */
function reconciledBranchRow() {
  return {
    artifactId: "branch-artifact-1",
    branchName: "feature/test",
    currentPullRequestDetailId: "pr-detail-1",
    checksStatus: ChecksStatus.Passing,
    currentPullRequestDetail: existingPullRequest(),
  };
}

function runDiff(over: { pullRequestMetadata?: unknown[] } = {}) {
  return githubBackfillProjectionWriter.diff({
    organizationId: ORGANIZATION_ID,
    repository: REPOSITORY,
    pullRequests: [readModelPullRequest()],
    ...over,
  } as never);
}

/**
 * Seed the store so that NOTHING would change: the branch, the PR, and every
 * child projection already match the incoming payload. Each test then perturbs
 * exactly one input and asserts the single counter that must move.
 */
function seedFullyReconciled() {
  dbMock.branchDetail.findMany.mockResolvedValue([reconciledBranchRow()]);
  dbMock.pullRequestDetail.findMany.mockResolvedValue([existingPullRequest()]);
  txMock.gitHubCommentProjection.findMany.mockResolvedValue([]);
  txMock.gitHubCommentThreadProjection.findMany.mockResolvedValue([
    existingReviewThreadProjectionRow(),
  ]);
  txMock.gitHubPRReview.findMany.mockResolvedValue([existingReviewRow()]);
  txMock.branchStatusCheck.findMany.mockResolvedValue([
    existingStatusCheckRow(),
  ]);
}

describe("githubBackfillProjectionWriter.diff — reconciled baseline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedFullyReconciled();
  });

  it("reports zero review-thread, review, and status-check changes when everything matches", async () => {
    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    // The baseline every other case in this file perturbs. If this drifts to a
    // non-zero, every "+1" assertion below stops meaning what it says.
    expect(diff.reviewThreadProjectionChangeCount).toBe(0);
    expect(diff.reviewProjectionChangeCount).toBe(0);
    expect(diff.statusCheckProjectionChangeCount).toBe(0);
  });

  it("counts no branch or PR change for an already-linked, already-matching PR", async () => {
    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    expect(diff.pullRequestProjectionChangeCount).toBe(0);
    expect(diff.branchProjectionChangeCount).toBe(0);
    expect(diff.skippedBranchCount).toBe(0);
  });

  it("does not read child projections at all when no metadata is supplied", async () => {
    const diff = await runDiff();

    // Metadata is optional: a PR-only backfill must not pay for comment,
    // review, or check queries, and must not report child-row changes it never
    // looked for.
    expect(diff.reviewThreadProjectionChangeCount).toBe(0);
    expect(diff.reviewProjectionChangeCount).toBe(0);
    expect(
      txMock.gitHubCommentThreadProjection.findMany
    ).not.toHaveBeenCalled();
    expect(txMock.gitHubPRReview.findMany).not.toHaveBeenCalled();
  });
});

describe("githubBackfillProjectionWriter.diff — review-thread drift", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedFullyReconciled();
  });

  it("counts a thread the store has never seen", async () => {
    txMock.gitHubCommentThreadProjection.findMany.mockResolvedValue([]);

    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    expect(diff.reviewThreadProjectionChangeCount).toBe(1);
  });

  it("counts a soft-deleted thread as a change, because the write resurrects it", async () => {
    txMock.gitHubCommentThreadProjection.findMany.mockResolvedValue([
      existingReviewThreadProjectionRow({ deletedAt: new Date() }),
    ]);

    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    // A row that exists but is deleted is NOT "already correct" — treating it
    // as unchanged would under-report the resurrection the write performs.
    expect(diff.reviewThreadProjectionChangeCount).toBe(1);
  });

  it.each([
    ["reviewThreadId", { reviewThreadId: "thread-node-changed" }],
    ["reviewId", { reviewId: "9999" }],
    ["path", { path: "other.ts" }],
    ["line", { line: 11 }],
    ["side", { side: "LEFT" }],
    ["startLine", { startLine: 3 }],
    ["startSide", { startSide: "LEFT" }],
    ["commitSha", { commitSha: "def456" }],
    ["htmlUrl", { htmlUrl: "https://github.com/other" }],
    ["legacyState", { legacyState: "PENDING" }],
  ])("counts a thread whose stored %s disagrees", async (_field, over) => {
    txMock.gitHubCommentThreadProjection.findMany.mockResolvedValue([
      existingReviewThreadProjectionRow(over),
    ]);

    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    // One case per compared field: a predicate that stopped comparing a field
    // would still answer true on the others, so only this shape catches it.
    expect(diff.reviewThreadProjectionChangeCount).toBe(1);
  });

  it("keys a reply comment to its parent thread rather than its own id", async () => {
    const metadata = pullRequestMetadata();
    metadata.reviewComments[0].in_reply_to_id = 1999;
    metadata.reviewComments[0].review_thread_node_id = null;
    txMock.gitHubCommentThreadProjection.findMany.mockResolvedValue([
      existingReviewThreadProjectionRow({
        reviewThreadId: null,
        rootCommentId: "1999",
      }),
    ]);

    const diff = await runDiff({ pullRequestMetadata: [metadata] });

    // A reply belongs to the thread it answers. Keying on the reply's own id
    // would make every reply look like a brand-new thread and inflate the
    // predicted blast radius on any PR with a conversation.
    expect(diff.reviewThreadProjectionChangeCount).toBe(0);
  });

  it("collapses several comments on one thread into a single predicted change", async () => {
    const metadata = pullRequestMetadata();
    const [first] = metadata.reviewComments;
    metadata.reviewComments = [
      first,
      { ...first, id: 2002, in_reply_to_id: 2001 },
      { ...first, id: 2003, in_reply_to_id: 2001 },
    ];
    txMock.gitHubCommentThreadProjection.findMany.mockResolvedValue([]);

    const diff = await runDiff({ pullRequestMetadata: [metadata] });

    // Threads are counted per THREAD, not per comment. All three share
    // `thread-node-2001`, so the write touches one thread row.
    expect(diff.reviewThreadProjectionChangeCount).toBe(1);
  });
});

describe("githubBackfillProjectionWriter.diff — review drift", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedFullyReconciled();
  });

  it("counts a review the store has never seen", async () => {
    txMock.gitHubPRReview.findMany.mockResolvedValue([]);

    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    expect(diff.reviewProjectionChangeCount).toBe(1);
  });

  it.each([
    ["githubReviewId", { githubReviewId: "9999" }],
    ["authorAvatarUrl", { authorAvatarUrl: null }],
    ["state", { state: ReviewDecision.ChangesRequested }],
    ["body", { body: "different" }],
    ["htmlUrl", { htmlUrl: "https://github.com/other" }],
    ["submittedAt", { submittedAt: new Date("2026-07-06T00:00:00.000Z") }],
  ])("counts a review whose stored %s disagrees", async (_field, over) => {
    txMock.gitHubPRReview.findMany.mockResolvedValue([existingReviewRow(over)]);

    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    expect(diff.reviewProjectionChangeCount).toBe(1);
  });

  it("compares submittedAt by instant, not by string", async () => {
    txMock.gitHubPRReview.findMany.mockResolvedValue([
      existingReviewRow({ submittedAt: new Date(1_783_209_840_000) }),
    ]);

    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    // Same instant as the fixture's 2026-07-05T00:04:00Z, constructed a
    // different way. A textual comparison here would repredict every review on
    // every backfill forever.
    expect(diff.reviewProjectionChangeCount).toBe(0);
  });

  it("counts only the latest review per author", async () => {
    const metadata = pullRequestMetadata();
    const [review] = metadata.reviews;
    metadata.reviews = [
      { ...review, id: 3000, submitted_at: "2026-07-04T00:00:00.000Z" },
      review,
      { ...review, id: 2999, submitted_at: "2026-07-03T00:00:00.000Z" },
    ];
    txMock.gitHubPRReview.findMany.mockResolvedValue([existingReviewRow()]);

    const diff = await runDiff({ pullRequestMetadata: [metadata] });

    // The projection stores one row per author, so three reviews by the same
    // reviewer are one row — and the one it keeps already matches.
    expect(diff.reviewProjectionChangeCount).toBe(0);
  });
});

describe("githubBackfillProjectionWriter.diff — status-check drift", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedFullyReconciled();
  });

  it("counts a check row the store has never seen", async () => {
    txMock.branchStatusCheck.findMany.mockResolvedValue([]);

    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    expect(diff.statusCheckProjectionChangeCount).toBe(1);
  });

  it.each([
    ["kind", { kind: "status_context" }],
    ["providerNodeId", { providerNodeId: "check-node-changed" }],
    ["name", { name: "lint" }],
    ["status", { status: "IN_PROGRESS" }],
    ["conclusion", { conclusion: "FAILURE" }],
    ["targetUrl", { targetUrl: "https://github.com/checks/2" }],
    ["position", { position: 1 }],
  ])("counts a check whose stored %s disagrees", async (_field, over) => {
    txMock.branchStatusCheck.findMany.mockResolvedValue([
      existingStatusCheckRow(over),
    ]);

    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    expect(diff.statusCheckProjectionChangeCount).toBe(1);
  });

  it("charges a flat single change when the provider rollup did not resolve", async () => {
    const metadata = pullRequestMetadata();
    metadata.statusCheckRollup = {
      ok: false,
      reason: StatusCheckRollupFailureReason.RateLimited,
    };

    const diff = await runDiff({ pullRequestMetadata: [metadata] });

    // A failed rollup short-circuits BEFORE the stored rows are read: the write
    // will record the unavailability, which is one change, and it cannot know
    // how many check rows that touches. Deliberately not 0 (the write is not a
    // no-op) and deliberately not a per-row count (it has no rows to count).
    expect(diff.statusCheckProjectionChangeCount).toBe(1);
    expect(txMock.branchStatusCheck.findMany).not.toHaveBeenCalled();
  });

  it("counts a stored check the provider no longer reports as a deletion", async () => {
    txMock.branchStatusCheck.findMany.mockResolvedValue([
      existingStatusCheckRow(),
      existingStatusCheckRow({ providerKey: "check-gone", name: "retired" }),
    ]);

    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    // The reverse sweep: a row whose provider key is absent from the live
    // rollup will be deleted, and the operator needs that in the predicted
    // total or a destructive backfill reads as a no-op.
    expect(diff.statusCheckProjectionChangeCount).toBe(1);
  });
});

describe("githubBackfillProjectionWriter.diff — a PR with no persisted row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedFullyReconciled();
    dbMock.pullRequestDetail.findMany.mockResolvedValue([]);
    dbMock.branchDetail.findMany.mockResolvedValue([
      {
        ...reconciledBranchRow(),
        currentPullRequestDetailId: null,
        currentPullRequestDetail: null,
      },
    ]);
  });

  it("charges the whole incoming payload as the blast radius", async () => {
    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    // With no existing PR there is nothing to diff against, so every incoming
    // child row is a write. The counts come from the PAYLOAD, not from queries.
    expect(diff.issueCommentProjectionChangeCount).toBe(1);
    expect(diff.reviewCommentProjectionChangeCount).toBe(1);
    expect(diff.reviewThreadProjectionChangeCount).toBe(1);
    expect(diff.reviewProjectionChangeCount).toBe(1);
    expect(diff.statusCheckProjectionChangeCount).toBe(1);
    expect(diff.pullRequestProjectionChangeCount).toBe(1);
  });

  it("does not query child projections for a PR it cannot diff", async () => {
    await runDiff({ pullRequestMetadata: [pullRequestMetadata()] });

    // The blast-radius path is pure arithmetic over the payload; issuing the
    // per-child queries anyway would cost a full round of reads per new PR.
    expect(
      txMock.gitHubCommentThreadProjection.findMany
    ).not.toHaveBeenCalled();
    expect(txMock.gitHubPRReview.findMany).not.toHaveBeenCalled();
    expect(txMock.branchStatusCheck.findMany).not.toHaveBeenCalled();
  });
});

describe("githubBackfillProjectionWriter.diff — unmatched branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedFullyReconciled();
  });

  it("skips a PR whose head branch has no local row and counts nothing else for it", async () => {
    dbMock.branchDetail.findMany.mockResolvedValue([]);

    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    // A branch the org never synced is out of scope entirely — it must be
    // reported as skipped rather than silently counted as a PR to write.
    expect(diff.skippedBranchCount).toBe(1);
    expect(diff.pullRequestProjectionChangeCount).toBe(0);
    expect(diff.branchProjectionChangeCount).toBe(0);
    expect(diff.reviewProjectionChangeCount).toBe(0);
  });

  it("counts a branch whose current-PR pointer does not match the resolved PR", async () => {
    dbMock.branchDetail.findMany.mockResolvedValue([
      {
        ...reconciledBranchRow(),
        currentPullRequestDetailId: "pr-detail-other",
      },
    ]);

    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    expect(diff.branchProjectionChangeCount).toBe(1);
  });

  it("counts a checks-status change on the branch", async () => {
    dbMock.branchDetail.findMany.mockResolvedValue([
      { ...reconciledBranchRow(), checksStatus: ChecksStatus.Failing },
    ]);

    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    expect(diff.checkProjectionChangeCount).toBe(1);
  });

  it("counts a review-decision change on the PR", async () => {
    dbMock.pullRequestDetail.findMany.mockResolvedValue([
      {
        ...existingPullRequest(),
        reviewDecision: ReviewDecision.ChangesRequested,
      },
    ]);

    const diff = await runDiff({
      pullRequestMetadata: [pullRequestMetadata()],
    });

    expect(diff.reviewDecisionProjectionChangeCount).toBe(1);
  });
});
