import "server-only";

import { LinkType } from "@repo/api/src/types/artifact";
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
import type { User } from "@repo/api/src/types/user";
import {
  ArtifactSubtype,
  ArtifactType,
  type TransactionClient,
  withDb,
} from "@repo/database";
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
  | { data: BranchViewData; error: null }
  | { data: null; error: string };

/**
 * Assemble the full BranchViewData response. Always reads comments/reviews
 * from the DB — resolvePrContext guarantees `ctx.gitHubPullRequest` is
 * non-null on success. The user-initiated `/sync` endpoint reconciles with
 * GitHub when the DB is out of date; no on-demand fallback is needed here.
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

  const [dbComments, dbReviews, featureCtx, planCtx, dbPr] = await Promise.all([
    fetchComments(gitHubPullRequest.id),
    fetchReviews(gitHubPullRequest.id),
    resolveFeatureContext(ctx),
    resolvePlanContext(ctx),
    withDb((db) =>
      db.pullRequestDetail.findUnique({
        where: { artifactId: gitHubPullRequest.id },
        select: { checksStatus: true, reviewDecision: true },
      })
    ),
  ]);

  return buildResult(
    ctx,
    livePr,
    committedFiles,
    dbComments,
    dbReviews,
    dbPr,
    featureCtx,
    planCtx,
    user
  );
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
  // Path 1: Use documentId shortcut from the resolved PR context.
  const producingDocumentId = ctx.gitHubPullRequest?.documentId;

  // Path 2: Walk artifact links from PR artifact -> producing Document.
  let resolvedArtifactId = producingDocumentId;
  if (!resolvedArtifactId) {
    const linkToArtifact = await withDb((db) =>
      db.artifactLink.findFirst({
        where: {
          targetId: ctx.externalLink.id,
          linkType: LinkType.Produces,
          source: { type: ArtifactType.DOCUMENT },
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
    db.artifactLink.findFirst({
      where: {
        targetId: resolvedArtifactId,
        linkType: LinkType.Produces,
        source: { type: ArtifactType.DOCUMENT },
      },
      select: { sourceId: true },
    })
  );

  const candidateIds = [featureLink?.sourceId, resolvedArtifactId].filter(
    Boolean
  ) as string[];

  const sourceArtifacts = await withDb((db) =>
    db.artifact.findMany({
      where: {
        id: { in: candidateIds },
        type: ArtifactType.DOCUMENT,
      },
      select: {
        slug: true,
        name: true,
        subtype: true,
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

  const feature = sourceArtifacts.find(
    (a) => a.subtype === ArtifactSubtype.FEATURE
  );

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
    slug: feature.slug ?? "",
    title: feature.name,
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
    db.artifact.findFirst({
      where: { id: artifactId, type: ArtifactType.DOCUMENT },
      select: { slug: true, name: true, subtype: true },
    })
  );

  if (artifact?.subtype === ArtifactSubtype.IMPLEMENTATION_PLAN) {
    return { slug: artifact.slug ?? "", title: artifact.name };
  }

  // Walk artifact links to find a plan that produced this artifact.
  const planLink = await withDb((db) =>
    db.artifactLink.findFirst({
      where: {
        targetId: artifactId,
        linkType: LinkType.Produces,
        source: { type: ArtifactType.DOCUMENT },
      },
      select: { sourceId: true },
    })
  );

  if (!planLink) {
    return null;
  }

  const plan = await withDb((db) =>
    db.artifact.findFirst({
      where: { id: planLink.sourceId, type: ArtifactType.DOCUMENT },
      select: { slug: true, name: true, subtype: true },
    })
  );

  if (plan?.subtype === ArtifactSubtype.IMPLEMENTATION_PLAN) {
    return { slug: plan.slug ?? "", title: plan.name };
  }

  return null;
}
