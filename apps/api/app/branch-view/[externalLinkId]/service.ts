import "server-only";

import type {
  BranchViewComment,
  BranchViewData,
  BranchViewFile,
  BranchViewReview,
  FileChangeStatus,
} from "@repo/api/src/types/branch-view";
import {
  ChecksStatus,
  CommentKind,
  ReviewDecision,
} from "@repo/api/src/types/branch-view";
import { DocumentType } from "@repo/api/src/types/document";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import type { User } from "@repo/api/src/types/user";
import { type TransactionClient, withDb } from "@repo/database";
import {
  getSinglePullRequest,
  listPullRequestFiles,
  listPullRequestIssueComments,
  listPullRequestReviewComments,
  listPullRequestReviews,
} from "@repo/github";
import { log } from "@repo/observability/log";
import type { PrContext } from "@/lib/resolve-pr-context";
import { recomputeAndUpdateAggregate } from "@/lib/review-decision-utils";

import { detectAuthorKind } from "./comment-utils";

/**
 * Map GitHub file status string to our FileChangeStatus.
 */
function mapFileStatus(status: string): FileChangeStatus {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    default:
      return "modified";
  }
}

/**
 * Map DB PRReviewCommentState to the ChecksStatus/ReviewDecision API contract.
 * Prisma enum values match the const object values we define in branch-view.ts.
 */
function mapChecksStatus(dbValue: string | null): ChecksStatus | null {
  if (!dbValue) {
    return null;
  }
  const mapping: Record<string, ChecksStatus> = {
    UNKNOWN: ChecksStatus.Unknown,
    PENDING: ChecksStatus.Pending,
    PASSING: ChecksStatus.Passing,
    FAILING: ChecksStatus.Failing,
  };
  return mapping[dbValue] ?? null;
}

function mapReviewDecision(
  dbValue: string | null | undefined
): ReviewDecision | null {
  if (!dbValue) {
    return null;
  }
  const mapping: Record<string, ReviewDecision> = {
    APPROVED: ReviewDecision.Approved,
    CHANGES_REQUESTED: ReviewDecision.ChangesRequested,
    COMMENTED: ReviewDecision.Commented,
    DISMISSED: ReviewDecision.Dismissed,
  };
  return mapping[dbValue] ?? null;
}

/** Derive comment kind from DB fields. */
function deriveCommentKind(row: {
  reviewId: string | null;
  path: string | null;
  line: number | null;
}): BranchViewComment["kind"] {
  if (row.reviewId === null && row.path === null && row.line === null) {
    return CommentKind.IssueComment;
  }
  return CommentKind.ReviewComment;
}

/** Review states we include in fallback/backfill. */
const VALID_REVIEW_STATES = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
]);

export type GetBranchViewResult =
  | { data: BranchViewData; error: null; backfillPromise?: Promise<void> }
  | { data: null; error: string };

/**
 * Assemble the full BranchViewData response.
 */
export async function getBranchViewData(
  ctx: PrContext,
  user: User
): Promise<GetBranchViewResult> {
  const { installationId, owner, repo, pullNumber, gitHubPullRequest } = ctx;

  // Fetch live PR data and file list in parallel
  const [livePr, fileList] = await Promise.all([
    getSinglePullRequest(installationId, owner, repo, pullNumber),
    listPullRequestFiles(installationId, owner, repo, pullNumber),
  ]);

  if (!livePr) {
    return { data: null, error: "Pull request not found on GitHub" };
  }

  // Map files to BranchViewFile[]
  const committedFiles: BranchViewFile[] = (fileList ?? []).map((f) => ({
    path: f.filename,
    previousPath: f.previous_filename ?? null,
    status: mapFileStatus(f.status),
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch ?? null,
  }));

  // Determine comments/reviews source: DB or GitHub API fallback
  let comments: BranchViewComment[];
  let reviews: BranchViewReview[];
  let backfillPromise: Promise<void> | undefined;
  let dbPr: {
    checksStatus: string | null;
    reviewDecision: string | null;
  } | null = null;

  if (gitHubPullRequest) {
    // DB-backed path
    const [dbComments, dbReviews, featureCtx, planCtx, prStatus] =
      await Promise.all([
        fetchComments(gitHubPullRequest.id),
        fetchReviews(gitHubPullRequest.id),
        resolveFeatureContext(ctx),
        resolvePlanContext(ctx),
        withDb((db) =>
          db.gitHubPullRequest.findUnique({
            where: { id: gitHubPullRequest.id },
            select: { checksStatus: true, reviewDecision: true },
          })
        ),
      ]);

    comments = dbComments;
    reviews = dbReviews;
    dbPr = prStatus;

    return buildResult(
      ctx,
      livePr,
      committedFiles,
      comments,
      reviews,
      dbPr,
      featureCtx,
      planCtx,
      user
    );
  }

  // Fallback path: no GitHubPullRequest row -- fetch from GitHub API
  const [apiInlineComments, apiGeneralComments, apiReviews] = await Promise.all(
    [
      listPullRequestReviewComments(installationId, owner, repo, pullNumber),
      listPullRequestIssueComments(installationId, owner, repo, pullNumber),
      listPullRequestReviews(installationId, owner, repo, pullNumber),
    ]
  );

  comments = mapFallbackComments(apiInlineComments, apiGeneralComments);
  reviews = mapFallbackReviews(apiReviews);

  // Trigger background backfill if all API calls succeeded
  if (
    apiInlineComments !== null &&
    apiGeneralComments !== null &&
    apiReviews !== null
  ) {
    backfillPromise = backfillPullRequestData(
      ctx,
      livePr,
      apiInlineComments,
      apiGeneralComments,
      apiReviews
    );
  }

  const [featureContext, planContext] = await Promise.all([
    resolveFeatureContext(ctx),
    resolvePlanContext(ctx),
  ]);

  const data: BranchViewData = {
    externalLinkId: ctx.externalLink.id,
    prTitle: livePr.title,
    externalUrl: ctx.externalLink.externalUrl,
    prNumber: livePr.number,
    prHtmlUrl: livePr.htmlUrl,
    featureSlug: featureContext?.slug ?? null,
    featureTitle: featureContext?.title ?? null,
    teamId: featureContext?.teamId ?? null,
    teamName: featureContext?.teamName ?? null,
    projectId: ctx.externalLink.projectId,
    projectName: featureContext?.projectName ?? null,
    headBranch: livePr.headBranch,
    baseBranch: livePr.baseBranch,
    headSha: livePr.headSha,
    prState: livePr.state,
    reviewDecision: null,
    checksStatus: null,
    isDraft: livePr.isDraft,
    authorLogin: livePr.authorLogin,
    isAuthor: Boolean(
      user.githubUsername &&
        livePr.authorLogin &&
        user.githubUsername.toLowerCase() === livePr.authorLogin.toLowerCase()
    ),
    repoFullName: `${owner}/${repo}`,
    committedFiles,
    reviews,
    comments,
    producedByPlanSlug: planContext?.slug ?? null,
    producedByPlanTitle: planContext?.title ?? null,
  };

  return { data, error: null, backfillPromise };
}

// --- API response type aliases ---

type ApiInlineComment = NonNullable<
  Awaited<ReturnType<typeof listPullRequestReviewComments>>
>[number];
type ApiGeneralComment = NonNullable<
  Awaited<ReturnType<typeof listPullRequestIssueComments>>
>[number];
type ApiReview = NonNullable<
  Awaited<ReturnType<typeof listPullRequestReviews>>
>[number];

/** Map GitHub API inline + general comments to BranchViewComment[]. */
function mapFallbackComments(
  apiInlineComments: ApiInlineComment[] | null,
  apiGeneralComments: ApiGeneralComment[] | null
): BranchViewComment[] {
  const inlineComments: BranchViewComment[] = (apiInlineComments ?? []).map(
    (c) => ({
      id: String(c.id),
      githubCommentId: String(c.id),
      author: c.user?.login ?? "unknown",
      authorAvatar: c.user?.avatar_url ?? null,
      authorKind: detectAuthorKind(c.user?.login ?? "unknown"),
      body: c.body,
      createdAt: c.created_at,
      path: c.path,
      line: c.line,
      state: "PENDING" as BranchViewComment["state"],
      reviewId: c.pull_request_review_id
        ? String(c.pull_request_review_id)
        : null,
      htmlUrl: c.html_url,
      inReplyToId: c.in_reply_to_id ? String(c.in_reply_to_id) : null,
      kind: CommentKind.ReviewComment,
    })
  );

  const generalComments: BranchViewComment[] = (apiGeneralComments ?? []).map(
    (c) => ({
      id: String(c.id),
      githubCommentId: String(c.id),
      author: c.user?.login ?? "unknown",
      authorAvatar: c.user?.avatar_url ?? null,
      authorKind: detectAuthorKind(c.user?.login ?? "unknown"),
      body: c.body,
      createdAt: c.created_at,
      path: null,
      line: null,
      state: "PENDING" as BranchViewComment["state"],
      reviewId: null,
      htmlUrl: c.html_url,
      inReplyToId: null,
      kind: CommentKind.IssueComment,
    })
  );

  return [...inlineComments, ...generalComments].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

/** Normalize latest-per-author from GitHub API reviews. */
function keepLatestReviewPerAuthor(
  reviews: ApiReview[]
): Map<string, ApiReview> {
  const latestByAuthor = new Map<string, ApiReview>();
  for (const r of reviews) {
    const login = r.user!.login;
    const existing = latestByAuthor.get(login);
    if (
      !existing ||
      new Date(r.submitted_at!).getTime() >
        new Date(existing.submitted_at!).getTime()
    ) {
      latestByAuthor.set(login, r);
    }
  }
  return latestByAuthor;
}

/** Map GitHub API reviews to BranchViewReview[]. */
function mapFallbackReviews(
  apiReviews: ApiReview[] | null
): BranchViewReview[] {
  const validApiReviews = (apiReviews ?? []).filter(
    (r) =>
      VALID_REVIEW_STATES.has(r.state) &&
      r.submitted_at !== null &&
      r.user?.login != null
  );

  const latestByAuthor = keepLatestReviewPerAuthor(validApiReviews);

  return [...latestByAuthor.values()]
    .map((r) => ({
      id: String(r.id),
      author: r.user!.login,
      authorAvatar: r.user!.avatar_url,
      state: r.state as BranchViewReview["state"],
      body: r.body,
      submittedAt: r.submitted_at!,
      htmlUrl: r.html_url,
    }))
    .sort(
      (a, b) =>
        new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    );
}

function buildResult(
  ctx: PrContext,
  livePr: NonNullable<Awaited<ReturnType<typeof getSinglePullRequest>>>,
  committedFiles: BranchViewFile[],
  comments: BranchViewComment[],
  reviews: BranchViewReview[],
  dbPr: { checksStatus: string | null; reviewDecision: string | null } | null,
  featureContext: FeatureContext | null,
  planContext: PlanContext | null,
  user: User
): GetBranchViewResult {
  const { owner, repo } = ctx;
  const authorLogin = livePr.authorLogin;
  const isAuthor = Boolean(
    user.githubUsername &&
      authorLogin &&
      user.githubUsername.toLowerCase() === authorLogin.toLowerCase()
  );

  const data: BranchViewData = {
    externalLinkId: ctx.externalLink.id,
    prTitle: livePr.title,
    externalUrl: ctx.externalLink.externalUrl,
    prNumber: livePr.number,
    prHtmlUrl: livePr.htmlUrl,
    featureSlug: featureContext?.slug ?? null,
    featureTitle: featureContext?.title ?? null,
    teamId: featureContext?.teamId ?? null,
    teamName: featureContext?.teamName ?? null,
    projectId: ctx.externalLink.projectId,
    projectName: featureContext?.projectName ?? null,
    headBranch: livePr.headBranch,
    baseBranch: livePr.baseBranch,
    headSha: livePr.headSha,
    prState: livePr.state,
    reviewDecision: mapReviewDecision(dbPr?.reviewDecision ?? undefined),
    checksStatus: mapChecksStatus(dbPr?.checksStatus ?? null),
    isDraft: livePr.isDraft,
    authorLogin,
    isAuthor,
    repoFullName: `${owner}/${repo}`,
    committedFiles,
    reviews,
    comments,
    producedByPlanSlug: planContext?.slug ?? null,
    producedByPlanTitle: planContext?.title ?? null,
  };

  return { data, error: null };
}

async function fetchComments(
  pullRequestId: string
): Promise<BranchViewComment[]> {
  const rows = await withDb((db) =>
    db.gitHubPRReviewComment.findMany({
      where: { pullRequestId },
      orderBy: { createdAt: "asc" },
    })
  );

  return rows.map((row) => ({
    id: row.githubCommentId,
    githubCommentId: row.githubCommentId,
    author: row.authorLogin,
    authorAvatar: row.authorAvatarUrl,
    authorKind: detectAuthorKind(row.authorLogin),
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    path: row.path,
    line: row.line,
    state: row.state as BranchViewComment["state"],
    reviewId: row.reviewId,
    htmlUrl: row.htmlUrl,
    inReplyToId: row.inReplyToId,
    kind: deriveCommentKind(row),
  }));
}

async function fetchReviews(
  pullRequestId: string
): Promise<BranchViewReview[]> {
  const rows = await withDb((db) =>
    db.gitHubPRReview.findMany({
      where: { pullRequestId },
      orderBy: { submittedAt: "desc" },
    })
  );

  return rows.map((row) => ({
    id: row.githubReviewId,
    author: row.authorLogin,
    authorAvatar: row.authorAvatarUrl,
    state: row.state as BranchViewReview["state"],
    body: row.body,
    submittedAt: row.submittedAt.toISOString(),
    htmlUrl: row.htmlUrl,
  }));
}

// --- Backfill ---

type LivePr = NonNullable<Awaited<ReturnType<typeof getSinglePullRequest>>>;

/**
 * Background DB backfill: creates GitHubPullRequest + comments + reviews rows
 * so future requests use the DB path and webhooks have a parent row.
 * Entire operation is wrapped in a single transaction.
 */
async function backfillPullRequestData(
  ctx: PrContext,
  livePr: LivePr,
  apiInlineComments: ApiInlineComment[],
  apiGeneralComments: ApiGeneralComment[],
  apiReviews: ApiReview[]
): Promise<void> {
  // Guard: need repositoryId to create PR row
  if (!ctx.repositoryId) {
    log.info("[branch-view/backfill] Skipping: no repositoryId", {
      externalLinkId: ctx.externalLink.id,
    });
    return;
  }

  // Resolve workstreamId
  const workstreamId = await resolveWorkstreamForBackfill(ctx);
  if (!workstreamId) {
    return;
  }

  const organizationId = ctx.externalLink.organizationId;

  await withDb.tx(async (tx) => {
    // 1. Upsert GitHubPullRequest
    const effectivePr = await tx.gitHubPullRequest.upsert({
      where: {
        repositoryId_number: {
          repositoryId: ctx.repositoryId!,
          number: livePr.number,
        },
      },
      create: {
        workstreamId,
        organizationId,
        repositoryId: ctx.repositoryId!,
        githubId: livePr.githubId,
        number: livePr.number,
        title: livePr.title,
        htmlUrl: livePr.htmlUrl,
        headBranch: livePr.headBranch,
        baseBranch: livePr.baseBranch,
        state: livePr.state,
        isDraft: livePr.isDraft,
        headSha: livePr.headSha,
      },
      update: {},
      select: { id: true, documentId: true },
    });

    // 2-3. Upsert comments
    await upsertBackfillComments(
      tx,
      effectivePr.id,
      apiInlineComments,
      apiGeneralComments
    );

    // 4. Upsert reviews
    await upsertBackfillReviews(tx, effectivePr.id, apiReviews);

    // 5. Recompute aggregate reviewDecision
    await recomputeAndUpdateAggregate(tx, effectivePr.id);
  });

  log.info("[branch-view/backfill] Completed", {
    externalLinkId: ctx.externalLink.id,
    prNumber: livePr.number,
    inlineComments: apiInlineComments.length,
    generalComments: apiGeneralComments.length,
    reviews: apiReviews.length,
  });
}

type PrismaReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED";

async function upsertBackfillComments(
  tx: TransactionClient,
  pullRequestId: string,
  apiInlineComments: ApiInlineComment[],
  apiGeneralComments: ApiGeneralComment[]
): Promise<void> {
  await Promise.all(
    apiInlineComments.map((c) =>
      tx.gitHubPRReviewComment.upsert({
        where: { githubCommentId: String(c.id) },
        create: {
          pullRequestId,
          githubCommentId: String(c.id),
          inReplyToId: c.in_reply_to_id ? String(c.in_reply_to_id) : null,
          reviewId: c.pull_request_review_id
            ? String(c.pull_request_review_id)
            : null,
          body: c.body,
          path: c.path,
          line: c.line,
          authorLogin: c.user?.login ?? "unknown",
          authorAvatarUrl: c.user?.avatar_url ?? null,
          state: "PENDING",
          htmlUrl: c.html_url,
          createdAt: new Date(c.created_at),
        },
        update: {},
      })
    )
  );

  await Promise.all(
    apiGeneralComments.map((c) =>
      tx.gitHubPRReviewComment.upsert({
        where: { githubCommentId: String(c.id) },
        create: {
          pullRequestId,
          githubCommentId: String(c.id),
          reviewId: null,
          body: c.body,
          path: null,
          line: null,
          authorLogin: c.user?.login ?? "unknown",
          authorAvatarUrl: c.user?.avatar_url ?? null,
          state: "PENDING",
          htmlUrl: c.html_url,
          createdAt: new Date(c.created_at),
        },
        update: {},
      })
    )
  );
}

async function upsertBackfillReviews(
  tx: TransactionClient,
  pullRequestId: string,
  apiReviews: ApiReview[]
): Promise<void> {
  const validReviews = apiReviews.filter(
    (r) =>
      VALID_REVIEW_STATES.has(r.state) &&
      r.submitted_at !== null &&
      r.user?.login != null
  );

  const latestByAuthor = keepLatestReviewPerAuthor(validReviews);

  await Promise.all(
    Array.from(latestByAuthor.values()).map((r) =>
      tx.gitHubPRReview.upsert({
        where: {
          pullRequestId_authorLogin: {
            pullRequestId,
            authorLogin: r.user!.login,
          },
        },
        create: {
          pullRequestId,
          githubReviewId: String(r.id),
          authorLogin: r.user!.login,
          authorAvatarUrl: r.user!.avatar_url ?? null,
          state: r.state as PrismaReviewDecision,
          body: r.body,
          htmlUrl: r.html_url,
          submittedAt: new Date(r.submitted_at!),
        },
        update: {
          githubReviewId: String(r.id),
          state: r.state as PrismaReviewDecision,
          body: r.body,
          htmlUrl: r.html_url,
          submittedAt: new Date(r.submitted_at!),
        },
      })
    )
  );
}

/**
 * Resolve a workstreamId for the backfill.
 * Tries ExternalLink.workstreamId first, then walks entity links.
 */
async function resolveWorkstreamForBackfill(
  ctx: PrContext
): Promise<string | null> {
  // Direct workstreamId on ExternalLink
  if (ctx.externalLink.workstreamId) {
    return ctx.externalLink.workstreamId;
  }

  // Walk entity links: ExternalLink -> Artifact (via PRODUCES) -> workstreamId
  const entityLinks = await withDb((db) =>
    db.entityLink.findMany({
      where: {
        organizationId: ctx.externalLink.organizationId,
        targetId: ctx.externalLink.id,
        targetType: EntityType.ExternalLink,
        sourceType: EntityType.Document,
        linkType: LinkType.Produces,
      },
      select: { sourceId: true },
    })
  );

  if (entityLinks.length === 0) {
    log.warn(
      "[branch-view/backfill] Skipping: no linked artifacts for workstream resolution",
      {
        externalLinkId: ctx.externalLink.id,
      }
    );
    return null;
  }

  const artifactIds = entityLinks.map((l) => l.sourceId);
  const artifacts = await withDb((db) =>
    db.document.findMany({
      where: { id: { in: artifactIds } },
      select: { workstreamId: true },
    })
  );

  const distinctWorkstreamIds = [
    ...new Set(
      artifacts
        .map((a) => a.workstreamId)
        .filter((id): id is string => id !== null)
    ),
  ];

  if (distinctWorkstreamIds.length === 1) {
    return distinctWorkstreamIds[0];
  }

  if (distinctWorkstreamIds.length === 0) {
    log.warn(
      "[branch-view/backfill] Skipping: no workstreamId on linked artifacts",
      {
        externalLinkId: ctx.externalLink.id,
      }
    );
  } else {
    log.warn("[branch-view/backfill] Skipping: ambiguous workstream", {
      externalLinkId: ctx.externalLink.id,
      workstreamIds: distinctWorkstreamIds,
    });
  }

  return null;
}

// --- Sync (user-initiated read-repair) ---

export type SyncResult =
  | { synced: true; error: null }
  | { synced: false; error: string };

export function buildStaleCommentDeleteWhere(
  pullRequestId: string,
  liveCommentIds: Set<string>
):
  | {
      pullRequestId: string;
    }
  | {
      pullRequestId: string;
      githubCommentId: { notIn: string[] };
    } {
  if (liveCommentIds.size === 0) {
    return { pullRequestId };
  }

  return {
    pullRequestId,
    githubCommentId: { notIn: [...liveCommentIds] },
  };
}

/**
 * User-initiated sync: fetch comments/reviews from GitHub API and upsert
 * into the existing GitHubPullRequest row. Callable from the sync endpoint.
 */
export async function syncCommentsAndReviews(
  ctx: PrContext
): Promise<SyncResult> {
  const { installationId, owner, repo, pullNumber, gitHubPullRequest } = ctx;

  if (!gitHubPullRequest) {
    return { synced: false, error: "No pull request record to sync into" };
  }

  const [apiInline, apiGeneral, apiRevs] = await Promise.all([
    listPullRequestReviewComments(installationId, owner, repo, pullNumber),
    listPullRequestIssueComments(installationId, owner, repo, pullNumber),
    listPullRequestReviews(installationId, owner, repo, pullNumber),
  ]);

  if (apiInline === null || apiGeneral === null || apiRevs === null) {
    return { synced: false, error: "Failed to fetch data from GitHub" };
  }

  // Collect all GitHub comment IDs for stale cleanup
  const liveCommentIds = new Set<string>([
    ...apiInline.map((c) => String(c.id)),
    ...apiGeneral.map((c) => String(c.id)),
  ]);

  await withDb.tx(async (tx) => {
    await upsertBackfillComments(
      tx,
      gitHubPullRequest.id,
      apiInline,
      apiGeneral
    );
    await upsertBackfillReviews(tx, gitHubPullRequest.id, apiRevs);
    await recomputeAndUpdateAggregate(tx, gitHubPullRequest.id);

    // Delete stale comments no longer present on GitHub, including the
    // "GitHub returned zero comments" case.
    await tx.gitHubPRReviewComment.deleteMany({
      where: buildStaleCommentDeleteWhere(gitHubPullRequest.id, liveCommentIds),
    });
  });

  log.info("[branch-view/sync] Completed", {
    externalLinkId: ctx.externalLink.id,
    prNumber: pullNumber,
    inlineComments: apiInline.length,
    generalComments: apiGeneral.length,
    reviews: apiRevs.length,
  });

  return { synced: true, error: null };
}

// --- Context resolvers ---

type FeatureContext = {
  slug: string;
  title: string;
  teamId: string | null;
  teamName: string | null;
  projectName: string | null;
};

async function resolveFeatureContext(
  ctx: PrContext
): Promise<FeatureContext | null> {
  // Path 1: Use artifactId shortcut from GitHubPullRequest
  const artifactId = ctx.gitHubPullRequest?.documentId;

  // Path 2: Walk entity links from ExternalLink -> Plan -> Feature
  // OR ExternalLink -> Feature
  let resolvedArtifactId = artifactId;
  if (!resolvedArtifactId) {
    const linkToArtifact = await withDb((db) =>
      db.entityLink.findFirst({
        where: {
          targetId: ctx.externalLink.id,
          targetType: EntityType.ExternalLink,
          linkType: LinkType.Produces,
          sourceType: EntityType.Document,
        },
        select: { sourceId: true },
      })
    );
    resolvedArtifactId = linkToArtifact?.sourceId ?? null;
  }

  if (!resolvedArtifactId) {
    // Try to at least get project name
    const project = await withDb((db) =>
      db.project.findUnique({
        where: { id: ctx.externalLink.projectId },
        select: { name: true },
      })
    );
    return project
      ? {
          slug: "",
          title: "",
          teamId: null,
          teamName: null,
          projectName: project.name,
        }
      : null;
  }

  // Go one more level up the source chain to find a feature.
  const featureLink = await withDb((db) =>
    db.entityLink.findFirst({
      where: {
        targetId: resolvedArtifactId,
        targetType: EntityType.Document,
        linkType: LinkType.Produces,
        sourceType: EntityType.Document,
      },
      select: { sourceId: true },
    })
  );

  const sourceDocuments = await withDb((db) =>
    db.document.findMany({
      where: {
        id: {
          in: [featureLink?.sourceId, resolvedArtifactId].filter(
            Boolean
          ) as string[],
        },
      },
      select: {
        slug: true,
        title: true,
        type: true,
        project: {
          select: {
            name: true,
            teams: {
              select: { team: { select: { id: true, name: true } } },
              take: 1,
            },
          },
        },
      },
    })
  );

  const feature = sourceDocuments.find((d) => d.type === DocumentType.Feature);

  if (!feature) {
    const project = await withDb((db) =>
      db.project.findUnique({
        where: { id: ctx.externalLink.projectId },
        select: { name: true },
      })
    );
    return project
      ? {
          slug: "",
          title: "",
          teamId: null,
          teamName: null,
          projectName: project.name,
        }
      : null;
  }

  const firstTeam = feature.project?.teams?.[0]?.team ?? null;

  return {
    slug: feature.slug,
    title: feature.title,
    teamId: firstTeam?.id ?? null,
    teamName: firstTeam?.name ?? null,
    projectName: feature.project?.name ?? null,
  };
}

type PlanContext = {
  slug: string;
  title: string;
};

async function resolvePlanContext(ctx: PrContext): Promise<PlanContext | null> {
  const artifactId = ctx.gitHubPullRequest?.documentId;
  if (!artifactId) {
    return null;
  }

  // Check if this artifact IS a plan
  const artifact = await withDb((db) =>
    db.document.findUnique({
      where: { id: artifactId },
      select: { slug: true, title: true, type: true },
    })
  );

  if (artifact?.type === DocumentType.ImplementationPlan) {
    return { slug: artifact.slug, title: artifact.title };
  }

  // Walk entity links to find a plan that produced this artifact
  const planLink = await withDb((db) =>
    db.entityLink.findFirst({
      where: {
        targetId: artifactId,
        targetType: EntityType.Document,
        linkType: LinkType.Produces,
        sourceType: EntityType.Document,
      },
      select: { sourceId: true },
    })
  );

  if (!planLink) {
    return null;
  }

  const plan = await withDb((db) =>
    db.document.findUnique({
      where: { id: planLink.sourceId },
      select: { slug: true, title: true, type: true },
    })
  );

  if (plan?.type === DocumentType.ImplementationPlan) {
    return { slug: plan.slug, title: plan.title };
  }

  return null;
}
