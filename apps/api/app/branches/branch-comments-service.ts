import {
  BranchCommentsBudget,
  BranchCommentsFailureReason,
  BranchCommentsState,
  type BranchPrComment,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
  fitBranchPrCommentsResponseBudget,
  trimBranchPrCommentBody,
} from "@repo/api/src/types/branch";
import {
  ArtifactType,
  GitHubCommentThreadKind,
  GitHubLegacyCommentState,
  type Prisma,
  ThreadSource,
  ThreadStatus,
  withDb,
} from "@repo/database";
import {
  GitHubProviderResultStatus,
  type GitHubPullRequestIssueComment,
  type GitHubPullRequestReview,
  type GitHubPullRequestReviewComment,
  listPullRequestIssueCommentsWithProviderResult,
  listPullRequestReviewCommentsWithProviderResult,
  listPullRequestReviewsWithProviderResult,
} from "@repo/github";
import { z } from "zod";
import {
  BRANCH_CURRENT_PULL_REQUEST_DETAIL_CANDIDATE_LIMIT,
  getOwnedCurrentPullRequestDetail,
} from "./branch-remote-evidence";

export const BRANCH_COMMENTS_MAX_COMMENTS = BranchCommentsBudget.MaxComments;
export const BRANCH_COMMENTS_PAGE_SIZE = BranchCommentsBudget.PageSize;
export const BRANCH_COMMENTS_MAX_BODY_BYTES = BranchCommentsBudget.MaxBodyBytes;
export const BRANCH_COMMENTS_MAX_RESPONSE_BYTES =
  BranchCommentsBudget.MaxResponseBytes;

const UUID_SCHEMA = z.uuid();

export const branchCommentsQuerySchema = z.object({}).strict();
export type BranchCommentsQuery = z.infer<typeof branchCommentsQuerySchema>;

type BranchCommentsClient = Parameters<typeof withDb>[0] extends (
  db: infer Db
) => unknown
  ? Db
  : never;

type BranchCommentsContext = {
  branchId: string;
  prNumber: number | null;
  prUrl: string | null;
  owner: string;
  repo: string;
  installationId: string | null;
  pullRequestDetailId: string | null;
};

type ProjectionRow = Prisma.CommentGetPayload<{
  select: typeof projectionCommentSelect;
}>;

type BranchCommentsContextRow = Prisma.ArtifactGetPayload<{
  select: typeof branchCommentsContextSelect;
}>;

export const branchCommentsService = {
  async getBranchComments(
    organizationId: string,
    branchId: string,
    _query: BranchCommentsQuery = {}
  ): Promise<BranchPrCommentsResponse | null> {
    if (!UUID_SCHEMA.safeParse(branchId).success) {
      return null;
    }

    const context = await withDb((db) =>
      findBranchCommentsContext(db, organizationId, branchId)
    );
    if (!context) {
      return null;
    }

    const pullRequestDetailId = context.pullRequestDetailId;
    const projectionRows: ProjectionRow[] = pullRequestDetailId
      ? await withDb((db) =>
          findActiveProjectionRows(db, organizationId, {
            ...context,
            pullRequestDetailId,
          })
        )
      : [];
    const projected = projectionRows.map(toProjectedComment);
    const mixedProjection = hasMixedProjectionEvidence(projectionRows);

    if (projected.length > 0) {
      return buildResponse(context, projected, {
        state: mixedProjection
          ? BranchCommentsState.StaleMixed
          : BranchCommentsState.Populated,
        mixedProjection,
        providerProofedAt: null,
        stale: mixedProjection,
      });
    }

    const installationId = context.installationId;
    const prNumber = context.prNumber;
    if (!(installationId && prNumber)) {
      return buildResponse(context, [], {
        state: BranchCommentsState.UnsyncedUnknown,
        mixedProjection,
        providerProofedAt: null,
        stale: false,
      });
    }

    const proof = await fetchProviderCommentsProof({
      ...context,
      installationId,
      prNumber,
    });
    if (proof.status !== GitHubProviderResultStatus.Success) {
      return buildResponse(context, [], {
        state: BranchCommentsState.ProviderError,
        failureReason: mapProviderFailure(proof.status),
        mixedProjection,
        providerProofedAt: new Date().toISOString(),
        stale: false,
      });
    }

    const comments = dedupeProviderComments(proof.value);
    return buildResponse(context, comments, {
      state:
        comments.length > 0
          ? BranchCommentsState.Populated
          : BranchCommentsState.SyncedEmpty,
      mixedProjection,
      providerProofedAt: new Date().toISOString(),
      stale: false,
    });
  },
};

const projectionCommentSelect = {
  id: true,
  body: true,
  plainText: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  githubProjection: {
    select: {
      githubCommentId: true,
      githubInReplyToCommentId: true,
      githubHtmlUrl: true,
      githubUpdatedAt: true,
      githubDeletedAt: true,
      externalAuthor: {
        select: {
          providerLogin: true,
          displayName: true,
          avatarUrl: true,
          profileUrl: true,
        },
      },
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
          legacyState: true,
          lastSyncedAt: true,
        },
      },
    },
  },
} satisfies Prisma.CommentSelect;

const branchCommentsContextSelect = {
  id: true,
  pullRequestDetails: {
    where: { isCurrent: true },
    orderBy: [{ repositoryId: "asc" }, { number: "desc" }, { id: "asc" }],
    select: {
      id: true,
      branchArtifactId: true,
      repositoryId: true,
      isCurrent: true,
      number: true,
      htmlUrl: true,
    },
    take: BRANCH_CURRENT_PULL_REQUEST_DETAIL_CANDIDATE_LIMIT,
  },
  branch: {
    select: {
      deletedAt: true,
      // FR12 visibility SSOT (PRD-510) — mirrors branch-read-service; never the
      // headShaSource-derived gate (the stale_push trap).
      firstPushedAt: true,
      repositoryId: true,
      currentPullRequestDetail: {
        select: {
          id: true,
          branchArtifactId: true,
          repositoryId: true,
          isCurrent: true,
          number: true,
          htmlUrl: true,
        },
      },
      repository: {
        select: {
          owner: true,
          name: true,
          installation: {
            select: { installationId: true },
          },
        },
      },
    },
  },
} satisfies Prisma.ArtifactSelect;

async function findBranchCommentsContext(
  db: BranchCommentsClient,
  organizationId: string,
  branchId: string
): Promise<BranchCommentsContext | null> {
  const row = await db.artifact.findFirst({
    where: {
      id: branchId,
      organizationId,
      type: ArtifactType.BRANCH,
      branch: {
        deletedAt: null,
      },
      AND: [branchCommentsRemoteEvidenceWhere(branchId)],
    },
    select: branchCommentsContextSelect,
  });
  if (!hasVisibleBranchCommentsContext(row)) {
    return null;
  }
  const detail = getOwnedCurrentPullRequestDetail(row);
  const repository = row?.branch?.repository;
  if (!(repository?.owner && repository.name)) {
    return null;
  }
  return {
    branchId: row.id,
    prNumber: detail?.number ?? null,
    prUrl: detail?.htmlUrl ?? null,
    owner: repository.owner,
    repo: repository.name,
    installationId: repository.installation?.installationId ?? null,
    pullRequestDetailId: detail?.id ?? null,
  };
}

function branchCommentsRemoteEvidenceWhere(
  branchId: string
): Prisma.ArtifactWhereInput {
  return {
    OR: [
      {
        pullRequestDetails: {
          some: { branchArtifactId: branchId, isCurrent: true },
        },
      },
      { branch: { firstPushedAt: { not: null } } },
    ],
  };
}

function hasVisibleBranchCommentsContext(
  row: BranchCommentsContextRow | null
): row is BranchCommentsContextRow & {
  branch: NonNullable<BranchCommentsContextRow["branch"]>;
} {
  const branch = row?.branch;
  if (!(row && branch)) {
    return false;
  }
  return (
    Boolean(getOwnedCurrentPullRequestDetail(row)) ||
    branch.firstPushedAt !== null
  );
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
    orderBy: { createdAt: "asc" },
    take: BRANCH_COMMENTS_MAX_COMMENTS + 1,
    select: projectionCommentSelect,
  });
}

function toProjectedComment(row: ProjectionRow): BranchPrComment {
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
    line: threadProjection?.line ?? null,
    resolved: row.thread.status === ThreadStatus.RESOLVED,
    author: {
      login: projection?.externalAuthor?.providerLogin ?? "unknown",
      displayName: projection?.externalAuthor?.displayName ?? null,
      avatarUrl: projection?.externalAuthor?.avatarUrl ?? null,
      profileUrl: projection?.externalAuthor?.profileUrl ?? null,
    },
    body: trimmed.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: (projection?.githubUpdatedAt ?? row.updatedAt).toISOString(),
    providerUrl: projection?.githubHtmlUrl ?? null,
    stale: hasLegacyFreshnessEvidence(row),
    bodyTruncated: trimmed.truncated,
  };
}

function toProviderIssueComment(
  comment: GitHubPullRequestIssueComment
): BranchPrComment {
  const trimmed = trimBranchPrCommentBody(comment.body);
  return {
    id: String(comment.id),
    providerNodeId: comment.node_id,
    providerCommentId: String(comment.id),
    kind: BranchPrCommentKind.Issue,
    threadId: null,
    inReplyToId: null,
    path: null,
    line: null,
    resolved: null,
    author: {
      login: comment.user?.login ?? "unknown",
      displayName: null,
      avatarUrl: comment.user?.avatar_url ?? null,
      profileUrl: null,
    },
    body: trimmed.body,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    providerUrl: comment.html_url,
    stale: false,
    bodyTruncated: trimmed.truncated,
  };
}

function toProviderReviewComment(
  comment: GitHubPullRequestReviewComment
): BranchPrComment {
  const trimmed = trimBranchPrCommentBody(comment.body);
  return {
    id: String(comment.id),
    providerNodeId: comment.node_id,
    providerCommentId: String(comment.id),
    kind: comment.in_reply_to_id
      ? BranchPrCommentKind.ReviewReply
      : BranchPrCommentKind.Review,
    threadId: comment.review_thread_node_id,
    inReplyToId: comment.in_reply_to_id ? String(comment.in_reply_to_id) : null,
    path: comment.path,
    line: comment.original_line ?? comment.line,
    resolved: comment.review_thread_is_resolved,
    author: {
      login: comment.user?.login ?? "unknown",
      displayName: null,
      avatarUrl: comment.user?.avatar_url ?? null,
      profileUrl: null,
    },
    body: trimmed.body,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    providerUrl: comment.html_url,
    stale: false,
    bodyTruncated: trimmed.truncated,
  };
}

function toProviderReviewBody(
  review: GitHubPullRequestReview
): BranchPrComment {
  const trimmed = trimBranchPrCommentBody(review.body ?? "");
  return {
    id: `review-${review.id}`,
    providerNodeId: null,
    providerCommentId: String(review.id),
    kind: BranchPrCommentKind.Review,
    threadId: null,
    inReplyToId: null,
    path: null,
    line: null,
    resolved: null,
    author: {
      login: review.user?.login ?? "unknown",
      displayName: null,
      avatarUrl: review.user?.avatar_url ?? null,
      profileUrl: null,
    },
    body: trimmed.body,
    createdAt: review.submitted_at ?? new Date(0).toISOString(),
    updatedAt: review.submitted_at,
    providerUrl: review.html_url,
    stale: false,
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

async function fetchProviderCommentsProof(
  context: BranchCommentsContext & { installationId: string; prNumber: number }
): Promise<
  | {
      status: typeof GitHubProviderResultStatus.Success;
      value: BranchPrComment[];
    }
  | {
      status: Exclude<
        GitHubProviderResultStatus,
        typeof GitHubProviderResultStatus.Success
      >;
    }
> {
  const comments: BranchPrComment[] = [];
  const issueComments = await listPullRequestIssueCommentsWithProviderResult(
    context.installationId,
    context.owner,
    context.repo,
    context.prNumber,
    providerProofListOptions(comments.length)
  );
  if (issueComments.status !== GitHubProviderResultStatus.Success) {
    return { status: issueComments.status };
  }
  comments.push(...issueComments.value.map(toProviderIssueComment));

  if (comments.length > BRANCH_COMMENTS_MAX_COMMENTS) {
    return { status: GitHubProviderResultStatus.Success, value: comments };
  }

  const reviewComments = await listPullRequestReviewCommentsWithProviderResult(
    context.installationId,
    context.owner,
    context.repo,
    context.prNumber,
    {
      ...providerProofListOptions(comments.length),
      includeReviewThreadMetadata: false,
    }
  );
  if (reviewComments.status !== GitHubProviderResultStatus.Success) {
    return { status: reviewComments.status };
  }
  comments.push(...reviewComments.value.map(toProviderReviewComment));

  if (comments.length > BRANCH_COMMENTS_MAX_COMMENTS) {
    return { status: GitHubProviderResultStatus.Success, value: comments };
  }

  const reviews = await listPullRequestReviewsWithProviderResult(
    context.installationId,
    context.owner,
    context.repo,
    context.prNumber,
    providerProofListOptions(comments.length)
  );
  if (reviews.status !== GitHubProviderResultStatus.Success) {
    return { status: reviews.status };
  }
  comments.push(
    ...reviews.value
      .filter((review) => Boolean(review.body?.trim()))
      .map(toProviderReviewBody)
  );

  return {
    status: GitHubProviderResultStatus.Success,
    value: comments,
  };
}

function providerProofListOptions(commentsSoFar: number): {
  limit: number;
  pageSize: number;
} {
  const remainingWithSentinel =
    BRANCH_COMMENTS_MAX_COMMENTS + 1 - commentsSoFar;
  return {
    limit: Math.max(1, remainingWithSentinel),
    pageSize: Math.min(BRANCH_COMMENTS_PAGE_SIZE, remainingWithSentinel),
  };
}

function dedupeProviderComments(
  comments: readonly BranchPrComment[]
): BranchPrComment[] {
  const seen = new Set<string>();
  const deduped: BranchPrComment[] = [];
  for (const comment of comments) {
    const key =
      comment.providerNodeId ?? `${comment.kind}:${comment.providerCommentId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(comment);
  }
  return deduped.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

function hasMixedProjectionEvidence(rows: readonly ProjectionRow[]): boolean {
  return rows.some(hasLegacyFreshnessEvidence);
}

function hasLegacyFreshnessEvidence(row: ProjectionRow): boolean {
  const projection = row.thread.githubProjection;
  if (!projection) {
    return false;
  }
  return (
    projection.lastSyncedAt !== null ||
    (projection.legacyState !== null &&
      projection.legacyState !== GitHubLegacyCommentState.PENDING)
  );
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

function mapProviderFailure(
  status: Exclude<
    GitHubProviderResultStatus,
    typeof GitHubProviderResultStatus.Success
  >
): BranchCommentsFailureReason {
  if (status === GitHubProviderResultStatus.ProviderRateLimit) {
    return BranchCommentsFailureReason.RateLimit;
  }
  return BranchCommentsFailureReason.ProviderUnavailable;
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
