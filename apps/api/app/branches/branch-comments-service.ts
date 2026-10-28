import {
  BranchCommentsBudget,
  BranchCommentsFailureReason,
  BranchCommentsState,
  type BranchPrComment,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import {
  type BranchSelectedPullRequestIdentity,
  branchSelectedPullRequestQuerySchema,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  fitBranchPrCommentsResponseBudget,
  trimBranchPrCommentBody,
} from "@repo/api/src/types/branch-comments-budget";
import { CommentSyncProvider } from "@repo/api/src/types/comment-thread-dto";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import {
  GitHubCommentThreadKind,
  type Prisma,
  ThreadSource,
  ThreadStatus,
  withDb,
} from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import { z } from "zod";
import {
  githubCommentExternalAuthorSelect,
  toBranchPrCommentAuthor,
} from "@/app/comments/github-author-provider-detail";
import { reconcilePullRequestCommentsOnView } from "@/app/comments/service/github/github-comment-on-demand-reconcile";
import {
  type GitHubCommentReconcileResult,
  GitHubCommentReconcileStatus,
} from "@/app/comments/service/github/github-comment-reconcile";
import {
  type PullRequestCommentsReconcileMarker,
  readPullRequestCommentsReconcileMarker,
} from "@/app/comments/service/github/github-comment-reconcile-marker";
import { hasUnconfirmedGitHubSync } from "@/app/comments/service/github/github-comment-sync-state";
import { gitHubSyncPoolIsEmpty } from "@/lib/github/github-sync-credential-probe";
import {
  type BranchCommentsClient,
  type BranchCommentsContext,
  findBranchCommentsContext,
} from "./branch-comments-context";
import { finalizeCloudBranchProductResponse } from "./branch-product-response-eligibility";

export const BRANCH_COMMENTS_MAX_COMMENTS = BranchCommentsBudget.MaxComments;
export const BRANCH_COMMENTS_PAGE_SIZE = BranchCommentsBudget.PageSize;
export const BRANCH_COMMENTS_MAX_BODY_BYTES = BranchCommentsBudget.MaxBodyBytes;
export const BRANCH_COMMENTS_MAX_RESPONSE_BYTES =
  BranchCommentsBudget.MaxResponseBytes;

const UUID_SCHEMA = z.uuid();

export const branchCommentsQuerySchema = branchSelectedPullRequestQuerySchema;
export type BranchCommentsQuery = z.infer<typeof branchCommentsQuerySchema>;

type ProjectionRow = Prisma.CommentGetPayload<{
  select: ReturnType<typeof projectionCommentSelect>;
}>;

export const branchCommentsService = {
  async getBranchComments(
    organizationId: string,
    branchId: string,
    query: BranchCommentsQuery = {}
  ): Promise<BranchPrCommentsResponse | null> {
    if (!UUID_SCHEMA.safeParse(branchId).success) {
      return null;
    }

    const context = await withDb((db) =>
      findBranchCommentsContext(
        db,
        organizationId,
        branchId,
        selectedPullRequestIdentity(query)
      )
    );
    if (!context) {
      return null;
    }
    const pullRequestDetailId = context.pullRequestDetailId;
    if (context.prNumber === null || pullRequestDetailId === null) {
      return finalizeCloudBranchProductResponse(
        organizationId,
        branchId,
        buildResponse(context, [], unsyncedUnknownState())
      );
    }
    const { marker, failure } = await reconcileOnFirstView(
      organizationId,
      pullRequestDetailId
    );
    const rows = await withDb((db) =>
      findActiveProjectionRows(db, organizationId, {
        ...context,
        pullRequestDetailId,
      })
    );
    const comments = rows.map((row) =>
      toProjectedComment(row, marker?.latestAttemptFailed ?? false)
    );
    return finalizeCloudBranchProductResponse(
      organizationId,
      branchId,
      buildResponse(
        context,
        comments,
        await readableStoredCommentsState(
          organizationId,
          context,
          storedCommentsState(comments, marker, failure)
        )
      )
    );
  },
};

const projectionCommentSelect = (organizationId: string) =>
  ({
    id: true,
    body: true,
    plainText: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
    syncStates: {
      where: { provider: CommentSyncProvider.Github },
      select: { state: true },
    },
    githubProjection: {
      select: {
        githubCommentId: true,
        githubInReplyToCommentId: true,
        githubHtmlUrl: true,
        githubUpdatedAt: true,
        githubDeletedAt: true,
        externalAuthor: githubCommentExternalAuthorSelect(organizationId),
      },
    },
    thread: {
      select: {
        id: true,
        status: true,
        githubProjection: {
          select: {
            threadKind: true,
            path: true,
            line: true,
            originalLine: true,
          },
        },
      },
    },
  }) satisfies Prisma.CommentSelect;

function selectedPullRequestIdentity(
  query: BranchCommentsQuery
): BranchSelectedPullRequestIdentity | undefined {
  return query.repositoryFullName && query.pullRequestNumber
    ? {
        repositoryFullName: query.repositoryFullName,
        pullRequestNumber: query.pullRequestNumber,
      }
    : undefined;
}

function findActiveProjectionRows(
  db: BranchCommentsClient,
  organizationId: string,
  context: BranchCommentsContext & { pullRequestDetailId: string }
) {
  return db.comment.findMany({
    where: {
      deletedAt: null,
      githubProjection: { is: { githubDeletedAt: null } },
      thread: {
        organizationId,
        artifactId: context.branchId,
        source: ThreadSource.GITHUB,
        githubProjection: {
          is: {
            branchArtifactId: context.branchId,
            pullRequestDetailId: context.pullRequestDetailId,
            deletedAt: null,
          },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: BRANCH_COMMENTS_MAX_COMMENTS + 1,
    select: projectionCommentSelect(organizationId),
  });
}

function toProjectedComment(
  row: ProjectionRow,
  latestAttemptFailed: boolean
): BranchPrComment {
  const projection = row.githubProjection;
  const threadProjection = row.thread.githubProjection;
  const body = commentBody(row.body, row.plainText);
  const trimmed = trimBranchPrCommentBody(body);
  return {
    id: row.id,
    providerNodeId: null,
    providerCommentId: projection?.githubCommentId ?? null,
    kind: projectedCommentKind(
      threadProjection?.threadKind,
      projection?.githubInReplyToCommentId ?? null
    ),
    threadId: row.thread.id,
    inReplyToId: projection?.githubInReplyToCommentId ?? null,
    path: threadProjection?.path ?? null,
    // The backfill stored an outdated comment's original line in `line` until
    // ISS-11212 gave it `originalLine`; keep showing that line for its rows.
    line: threadProjection?.line ?? threadProjection?.originalLine ?? null,
    resolved: row.thread.status === ThreadStatus.RESOLVED,
    author: projection?.externalAuthor
      ? toBranchPrCommentAuthor(projection.externalAuthor)
      : {
          login: "unknown",
          displayName: null,
          avatarUrl: null,
          profileUrl: null,
        },
    body: trimmed.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: (projection?.githubUpdatedAt ?? row.updatedAt).toISOString(),
    providerUrl: projection?.githubHtmlUrl ?? null,
    stale: latestAttemptFailed || hasUnconfirmedGitHubSync(row),
    bodyTruncated: trimmed.truncated,
  };
}

function buildResponse(
  context: BranchCommentsContext,
  comments: BranchPrComment[],
  state: {
    state: BranchCommentsState;
    failureReason?: BranchCommentsFailureReason;
    providerProofedAt: string | null;
    mixedProjection: boolean;
    stale: boolean;
  }
): BranchPrCommentsResponse {
  const sliced = comments.slice(0, BRANCH_COMMENTS_MAX_COMMENTS);
  const bodyTruncatedCount = sliced.filter(
    (comment) => comment.bodyTruncated
  ).length;
  const initial: BranchPrCommentsResponse = {
    branchId: context.branchId,
    repositoryFullName: context.repositoryFullName,
    state:
      comments.length > BRANCH_COMMENTS_MAX_COMMENTS
        ? BranchCommentsState.OverLimitTruncated
        : state.state,
    comments: sliced,
    budget: {
      maxComments: BRANCH_COMMENTS_MAX_COMMENTS,
      pageSize: BRANCH_COMMENTS_PAGE_SIZE,
      maxBodyBytes: BRANCH_COMMENTS_MAX_BODY_BYTES,
      maxResponseBytes: BRANCH_COMMENTS_MAX_RESPONSE_BYTES,
      providerTruncated: comments.length > BRANCH_COMMENTS_MAX_COMMENTS,
      responseTruncated: false,
      omittedComments: Math.max(0, comments.length - sliced.length),
      bodyTruncatedCount,
    },
    providerProofedAt: state.providerProofedAt,
    stale: state.stale,
    mixedProjection: state.mixedProjection,
    prNumber: context.prNumber,
    prUrl: context.prUrl,
  };
  if (state.failureReason) {
    initial.failureReason = state.failureReason;
  }
  return fitBranchPrCommentsResponseBudget(initial);
}

function commentBody(
  value: Prisma.JsonValue,
  plainText: string | null
): string {
  if (plainText) {
    return plainText;
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.markdown === "string"
  ) {
    return value.markdown;
  }
  return "";
}

function projectedCommentKind(
  threadKind: GitHubCommentThreadKind | null | undefined,
  inReplyToId: string | null
): BranchPrCommentKind {
  if (isIssueCommentThreadKind(threadKind)) {
    return BranchPrCommentKind.Issue;
  }
  if (inReplyToId) {
    return BranchPrCommentKind.ReviewReply;
  }
  return BranchPrCommentKind.Review;
}

function isIssueCommentThreadKind(
  threadKind: GitHubCommentThreadKind | null | undefined
): boolean {
  return threadKind === GitHubCommentThreadKind.ISSUE_COMMENT;
}

type BranchCommentsResponseState = Parameters<typeof buildResponse>[2];

/**
 * PLN-2122 decision 5: a pull request no complete reconcile has covered is
 * reconciled on first view, within the budget, unless a reconcile was attempted
 * within the cron's freshness floor (Kerensa, 2026-10-02).
 */
async function reconcileOnFirstView(
  organizationId: string,
  pullRequestDetailId: string
): Promise<{
  marker: PullRequestCommentsReconcileMarker | null;
  failure: GitHubCommentReconcileResult | null;
}> {
  const marker = await readPullRequestCommentsReconcileMarker(
    organizationId,
    pullRequestDetailId
  );
  if (!marker || marker.reconciledAt || !marker.attemptDue) {
    return { marker, failure: null };
  }
  const result = await reconcilePullRequestCommentsOnView(pullRequestDetailId);
  return {
    marker: await readPullRequestCommentsReconcileMarker(
      organizationId,
      pullRequestDetailId
    ),
    failure:
      result?.status === GitHubCommentReconcileStatus.ProviderError
        ? result
        : null,
  };
}

/** PLN-2122 decision 9: stored rows first, then the reconcile's evidence. */
function storedCommentsState(
  comments: readonly BranchPrComment[],
  marker: PullRequestCommentsReconcileMarker | null,
  failure: GitHubCommentReconcileResult | null
): BranchCommentsResponseState {
  if (comments.length > 0) {
    const stale = comments.some((comment) => comment.stale);
    return {
      state: stale
        ? BranchCommentsState.StaleMixed
        : BranchCommentsState.Populated,
      mixedProjection: stale,
      providerProofedAt: null,
      stale,
    };
  }
  if (marker?.reconciledAt) {
    return {
      state: BranchCommentsState.SyncedEmpty,
      mixedProjection: false,
      providerProofedAt: marker.reconciledAt.toISOString(),
      stale: marker.latestAttemptFailed,
    };
  }
  if (failure) {
    return providerErrorState(reconcileFailureReason(failure.errorCode));
  }
  // The failed attempt's own code is not persisted, so a later view inside the
  // freshness floor reports the generic one.
  if (marker?.latestAttemptFailed) {
    return providerErrorState(BranchCommentsFailureReason.ProviderError);
  }
  return unsyncedUnknownState();
}

function providerErrorState(
  failureReason: BranchCommentsFailureReason
): BranchCommentsResponseState {
  return {
    state: BranchCommentsState.ProviderError,
    failureReason,
    mixedProjection: false,
    providerProofedAt: new Date().toISOString(),
    stale: false,
  };
}

function unsyncedUnknownState(): BranchCommentsResponseState {
  return {
    state: BranchCommentsState.UnsyncedUnknown,
    mixedProjection: false,
    providerProofedAt: null,
    stale: false,
  };
}

const RATE_LIMITED_RECONCILE_ERRORS: ReadonlySet<string> = new Set([
  GitHubProviderResultStatus.ProviderRateLimit,
  GitHubAccessDenialReason.RateLimited,
]);

function reconcileFailureReason(
  errorCode: string | undefined
): BranchCommentsFailureReason {
  return errorCode && RATE_LIMITED_RECONCILE_ERRORS.has(errorCode)
    ? BranchCommentsFailureReason.RateLimit
    : BranchCommentsFailureReason.ProviderUnavailable;
}

/**
 * ISS-11212 operator correction (Kerensa, 2026-10-05): a repository the sync lane
 * has no credential for keeps the UnsyncedUnknown the read showed before, even
 * once an attempt has failed for want of one.
 */
async function readableStoredCommentsState(
  organizationId: string,
  context: BranchCommentsContext,
  state: BranchCommentsResponseState
): Promise<BranchCommentsResponseState> {
  if (state.state !== BranchCommentsState.ProviderError) {
    return state;
  }
  const poolIsEmpty = await gitHubSyncPoolIsEmpty({
    organizationId,
    target: { owner: context.owner, repo: context.repo },
  });
  return poolIsEmpty ? unsyncedUnknownState() : state;
}
