import {
  BranchViewCommentWriteIdentityStatus,
  GitHubCommentThreadKind,
  GitHubDiffSide,
  PRReviewCommentState,
} from "@repo/api/src/types/branch-view";
import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import type { GitHubPullRequestReviewComment } from "@repo/github/comment-payloads";
import type {
  createInlineReviewComment,
  deleteReviewComment,
  editReviewComment,
  replyToReviewComment,
} from "@/app/branch-view/[externalLinkId]/comments/direct-write-service";

type EditReviewCommentInput = Parameters<typeof editReviewComment>[0];
type CreateInlineReviewCommentInput = Parameters<
  typeof createInlineReviewComment
>[0];
type ReplyToReviewCommentInput = Parameters<typeof replyToReviewComment>[0];
type DeleteReviewCommentInput = Parameters<typeof deleteReviewComment>[0];

/**
 * Shared fixtures for the Branch View direct-write suites.
 *
 * Extracted (ISS-5291) so the write-path suite and the projection-reconciliation
 * suite build their PR context, review targets, and provider responses from ONE
 * shape. Both suites assert what the projection writes given a provider response
 * and a stored thread, so two hand-kept copies would let one pass while
 * comparing against a row the other half never produces.
 *
 * Only the PURE fixtures live here. The `install*` helpers stay with their
 * suites: each owns its own hoisted `vi.fn()` mocks, so a shared installer would
 * have to take them as parameters and would read worse than the duplication.
 */

/** The one caller-resolved client the write path threads in (PLN-1525). */
export const WRITE_OCTOKIT = { marker: "write-octokit" };

export function testUser(): EditReviewCommentInput["user"] {
  return {
    active: true,
    avatarUrl: null,
    clerkId: "clerk-user-1",
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    email: "author@example.test",
    firstName: "Test",
    githubUsername: "author",
    id: "user-1",
    lastName: "Author",
    linearId: null,
    organizationId: "org-1",
    phoneNumber: null,
    role: "ENGINEER",
    slackId: null,
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
  };
}

export function authContext(): EditReviewCommentInput["auth"] {
  return {
    authMethod: "session",
    clerkOrgId: "org-1",
    clerkUserId: "clerk-user-1",
    user: testUser(),
  };
}

export function prContext():
  | CreateInlineReviewCommentInput["ctx"]
  | ReplyToReviewCommentInput["ctx"]
  | EditReviewCommentInput["ctx"]
  | DeleteReviewCommentInput["ctx"] {
  return {
    externalLink: {
      createdBy: { githubUsername: "author" },
      externalUrl: "https://github.com/closedloop/runtime/pull/1197",
      id: "branch-artifact-1",
      metadata: null,
      organizationId: "org-1",
      projectId: "project-1",
      status: "OPEN",
      title: "FEA-1197",
    },
    prMetadata: {
      baseBranch: "main",
      headBranch: "fea-1197",
      number: 1197,
      state: "OPEN",
    },
    owner: "closedloop",
    repo: "runtime",
    pullNumber: 1197,
    installationId: "installation-1",
    repositoryId: "repo-1",
    branch: {
      artifactId: "branch-artifact-1",
      baseBranch: "main",
      baseBranchSource: "test",
      branchName: "fea-1197",
      checksStatus: "passing",
      checksDetailHeadSha: null,
      checksDetailTotalCount: 0,
      checksDetailTruncated: false,
      checksDetailProviderState: null,
      checksDetailUnavailableReason: null,
      checksDetailUpdatedAt: null,
      statusChecks: [],
      currentPullRequestDetailId: "pull-request-detail-1",
      fileCacheFileCount: 1,
      fileCacheHeadSha: "head-sha",
      fileCachePatchBytes: 100,
      fileCacheStatus: "fresh",
      fileCacheUpdatedAt: null,
      headSha: "head-sha",
      headShaObservedAt: null,
      headShaSource: "test",
      lastPushBeforeSha: null,
      lastSyncCompletedAt: null,
      lastSyncErrorCode: null,
      lastSyncErrorMessage: null,
      lastSyncStartedAt: null,
      repositoryId: "repo-1",
      syncStatus: "fresh",
    },
    gitHubPullRequest: {
      baseBranch: "main",
      checksStatus: "passing",
      documentId: null,
      githubId: "github-pr-1197",
      headBranch: "fea-1197",
      headSha: "head-sha",
      htmlUrl: "https://github.com/closedloop/runtime/pull/1197",
      id: "pull-request-detail-1",
      isDraft: false,
      number: 1197,
      repositoryId: "repo-1",
      reviewDecision: null,
      state: "OPEN",
      title: "FEA-1197",
    },
  };
}

export type ReviewTargetRowInput = {
  deletedAt: Date | null;
  githubDeletedAt: Date | null;
  authorLogin?: string;
  authorGithubUserId?: string;
  line?: number | null;
  path?: string | null;
  resolvable?: boolean;
  reviewThreadId?: string | null;
  startLine?: number | null;
  startSide?: GitHubDiffSide | null;
  status?: ThreadStatus;
};

export function reviewTargetRow(input: ReviewTargetRowInput) {
  return {
    id: "comment-1",
    deletedAt: input.deletedAt,
    githubProjection: {
      githubCommentId: "123456",
      githubDeletedAt: input.githubDeletedAt,
      externalAuthor: {
        providerLogin: input.authorLogin ?? "author",
        providerUserId: input.authorGithubUserId ?? "42",
      },
    },
    thread: {
      id: "thread-1",
      source: ThreadSource.Github,
      status: input.status ?? ThreadStatus.Open,
      githubProjection: {
        commitSha: "head-sha",
        htmlUrl:
          "https://github.com/closedloop/runtime/pull/1197#discussion_r123456",
        line: input.line === undefined ? 10 : input.line,
        path: input.path === undefined ? "src/runtime.ts" : input.path,
        reviewId: "review-1",
        reviewThreadId:
          input.reviewThreadId === undefined
            ? "review-thread-1"
            : input.reviewThreadId,
        rootCommentId: "123456",
        side: GitHubDiffSide.Right,
        startLine: input.startLine ?? null,
        startSide: input.startSide ?? null,
        resolvable: input.resolvable ?? true,
      },
    },
  };
}

export function writeIdentity() {
  return {
    ok: true,
    value: {
      githubUserConnectionId: "github-user-connection-1",
      githubUserId: "42",
      login: "author",
      organizationId: "org-1",
      scopes: ["repo"],
      octokit: WRITE_OCTOKIT,
      userId: "user-1",
    },
  };
}

export function writeIdentityStatus() {
  return {
    ok: true,
    value: {
      status: BranchViewCommentWriteIdentityStatus.Active,
      githubUserId: "42",
      login: "author",
    },
  };
}

/**
 * A provider response in the shape `updatePullRequestReviewCommentWithUserToken`
 * and its create/reply siblings actually return.
 *
 * Typed as the canonical `GitHubPullRequestReviewComment` on purpose: that type
 * is what `mapPullRequestReviewComment` normalizes every REST response into, so
 * a fixture looser than it can hand the write path a shape production can never
 * receive — and pin behavior on it.
 */
export function providerComment(input: {
  id: number;
  inReplyToId?: number | null;
}): GitHubPullRequestReviewComment {
  return {
    id: input.id,
    node_id: `MDI0OlB1bGxSZXF1ZXN0${input.id}`,
    body: input.inReplyToId ? "reply" : "inline",
    path: "src/index.ts",
    line: 3,
    side: GitHubDiffSide.Right,
    start_line: null,
    start_side: null,
    original_line: 3,
    original_start_line: null,
    author_association: "MEMBER",
    commit_id: "head-sha",
    html_url: `https://github.com/closedloop/runtime/pull/1197#discussion_r${input.id}`,
    pull_request_review_id: 777,
    review_thread_node_id: "review-thread-node-1",
    review_thread_is_resolved: false,
    in_reply_to_id: input.inReplyToId ?? null,
    created_at: "2026-05-21T00:00:00.000Z",
    updated_at: "2026-05-21T00:00:00.000Z",
    deleted_at: null,
    is_deleted: false,
    is_updated: true,
    user: {
      id: 42,
      login: "author",
      node_id: "MDQ6VXNlcjQy",
      avatar_url: "https://avatars.example.test/author.png",
    },
  };
}

/**
 * The post-write re-read row.
 *
 * `reconciled` is how a suite carries what the transaction just WROTE into the
 * row the same transaction reads back. Without it the re-read is a constant, so
 * the returned `result.comment` reports Open/Pending no matter what the write
 * put on the thread, and the write and response projections can drift with a
 * green suite.
 */
export function projectedCommentRow(
  query: unknown,
  reconciled?: {
    status?: ThreadStatus;
    legacyState?: PRReviewCommentState;
  }
) {
  const githubCommentId =
    ((query as ProjectedCommentQuery).where.githubProjection.is
      .githubCommentId as string) ?? "123456";
  const inReplyToId = githubCommentId === "123457" ? "123456" : null;
  const body = inReplyToId ? "reply" : "inline";
  return {
    id: `comment-${githubCommentId}`,
    body: { type: "github_markdown", markdown: body },
    plainText: body,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    githubProjection: {
      githubCommentId,
      githubInReplyToCommentId: inReplyToId,
      githubHtmlUrl: `https://github.com/closedloop/runtime/pull/1197#discussion_r${githubCommentId}`,
      externalAuthor: {
        providerLogin: "author",
        avatarUrl: "https://avatars.example.test/author.png",
        profileUrl: "https://github.com/author",
      },
    },
    thread: {
      id: "thread-1",
      source: ThreadSource.Github,
      status: reconciled?.status ?? ThreadStatus.Open,
      githubProjection: {
        legacyState: reconciled?.legacyState ?? PRReviewCommentState.Pending,
        threadKind: GitHubCommentThreadKind.ReviewThread,
        reviewId: "777",
        htmlUrl: `https://github.com/closedloop/runtime/pull/1197#discussion_r${githubCommentId}`,
        path: "src/index.ts",
        line: 3,
        commitSha: "head-sha",
        side: GitHubDiffSide.Right,
        startLine: null,
        startSide: null,
        resolvable: true,
      },
    },
  };
}

export function isProjectedCommentLookup(query: unknown): boolean {
  return Boolean(
    query &&
      typeof query === "object" &&
      "where" in query &&
      (query as { where?: { deletedAt?: unknown } }).where?.deletedAt === null
  );
}

export type ProjectedCommentQuery = {
  where: {
    id?: string;
    deletedAt?: null;
    githubProjection: {
      is: { githubCommentId: unknown; githubDeletedAt?: null };
    };
    thread?: unknown;
  };
};
