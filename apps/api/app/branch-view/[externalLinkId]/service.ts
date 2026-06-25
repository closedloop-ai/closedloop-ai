import "server-only";

import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  BranchFileCacheStatus,
  BranchSyncStatus,
  LinkType,
} from "@repo/api/src/types/artifact";
import type {
  BranchViewBranch,
  BranchViewComment,
  BranchViewCurrentPullRequest,
  BranchViewData,
  BranchViewFile,
  BranchViewLoadErrorDetails,
  BranchViewReview,
  BranchViewSyncOutcome,
  BranchViewSyncRequest,
  BranchViewSyncState,
} from "@repo/api/src/types/branch-view";
import {
  BRANCH_VIEW_BACKGROUND_STALE_MS,
  BRANCH_VIEW_IN_FLIGHT_STALE_MS,
  BRANCH_VIEW_PROVIDER_RETRY_FALLBACK_SECONDS,
  BranchViewCommentAction,
  BranchViewFileCacheSyncErrorCode,
  BranchViewLoadErrorCode,
  BranchViewPrLifecycleRepairStatus,
  BranchViewSyncErrorCode,
  BranchViewSyncFailureReason,
  BranchViewSyncOutcomeSource,
  BranchViewSyncPresentationState,
  BranchViewSyncScope,
  BranchViewSyncThrottleReason,
  ChecksStatus,
  CommentKind,
  FileChangeStatus,
  GitHubCommentThreadKind,
  PrCommentAuthorKind,
  ReviewDecision,
} from "@repo/api/src/types/branch-view";
import type { JsonObject } from "@repo/api/src/types/common";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  Result,
  type Result as ServiceResult,
  Status,
  type StatusCode,
} from "@repo/api/src/types/result";
import type { User } from "@repo/api/src/types/user";
import {
  ArtifactSubtype,
  ArtifactType,
  GitHubInstallationStatus,
  GitHubLegacyCommentState,
  ThreadSource,
  ThreadStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import {
  GitHubProviderResultStatus,
  listPullRequestIssueCommentsWithProviderResult,
  listPullRequestReviewCommentsWithProviderResult,
  listPullRequestReviewsWithProviderResult,
  queryStatusCheckRollupWithProviderResult,
} from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  markBranchSyncCompleted,
  markBranchSyncFailed,
  markBranchSyncProviderRateLimited,
  parseBranchSyncStatus,
  startBranchSync,
} from "@/app/branches/branch-sync-status";
import { refreshBranchFileChangeCache } from "@/app/branches/file-cache-service";
import type {
  ExternalGitHubAuthorSource,
  ExternalGitHubUser,
  ResolvedExternalGitHubAuthor,
} from "@/app/comments/external-authors";
import {
  normalizeExternalGitHubAuthor,
  normalizeGitHubLogin,
  resolveExternalGitHubAuthorInTransaction,
} from "@/app/comments/external-authors";
import { normalizeGitHubDiffSide } from "@/app/comments/github-diff-side";
import { getGitHubWriteIdentityStatus } from "@/app/comments/github-identity";
import {
  softDeleteGitHubCommentProjection,
  upsertGitHubIssueCommentThread,
  upsertGitHubReviewCommentThread,
} from "@/app/comments/github-projection";
import {
  githubService,
  RepositoryArtifactRelinkReason,
  type RepositoryArtifactRelinkResult,
  RepositoryArtifactRelinkStatus,
} from "@/app/integrations/github/service";
import {
  persistBranchStatusChecksFromRollup,
  projectBranchStatusChecks,
} from "@/lib/branch-status-checks";
import {
  type PrLifecycleRefreshResult,
  refreshPullRequestLifecycle,
} from "@/lib/pr-lifecycle-refresh";
import {
  getPrReadRepairStatus,
  isPrReadRepairEligible,
  type PrReadRepairInput,
  schedulePrReadRepair,
} from "@/lib/pr-read-repair";
import {
  BranchViewContextCredentialMode,
  BranchViewContextCredentialSource,
  type PrContext,
  resolvePrContext,
} from "@/lib/resolve-pr-context";
import { recomputeAndUpdateAggregate } from "@/lib/review-decision-utils";
import { scheduleLogFlush } from "@/lib/route-utils";

import { toBranchViewComment } from "./comment-utils";
import {
  buildActionPromptEligibility,
  buildCreatePromptEligibility,
} from "./comments/identity-prompt-service";
import {
  BranchViewGithubIdentityStatus,
  canPerformBranchViewCommentAction,
} from "./comments/permissions";

/**
 * Map GitHub file status string to our FileChangeStatus.
 */
function mapFileStatus(status: string): FileChangeStatus {
  switch (status) {
    case "added":
      return FileChangeStatus.Added;
    case "removed":
      return FileChangeStatus.Removed;
    case "renamed":
      return FileChangeStatus.Renamed;
    case "copied":
      return FileChangeStatus.Copied;
    default:
      return FileChangeStatus.Modified;
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

function mapPrState(dbValue: string | null | undefined): GitHubPRState {
  switch (dbValue) {
    case GitHubPRState.Open:
    case GitHubPRState.Merged:
    case GitHubPRState.Closed:
      return dbValue;
    default:
      log.warn("[branch-view] Invalid PR state, defaulting to OPEN", {
        prState: dbValue,
      });
      return GitHubPRState.Open;
  }
}

function isoOrNull(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/** Review states we include in fallback/backfill. */
const VALID_REVIEW_STATES = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
]);
const UNSAFE_PATH_SEGMENT_PATTERN = /[/?#]/;

export type GetBranchViewResult = ServiceResult<
  BranchViewData,
  BranchViewLoadFailure
>;

export type BranchViewLoadFailure = {
  code: BranchViewLoadErrorCode;
  message: string;
  status: StatusCode;
  details?: JsonObject;
};

export type BranchViewAuthContext = {
  authMethod: "session" | "api_key";
  organizationId: string;
  apiKeyScopes?: ApiKeyScope[];
};

/**
 * Assemble the full BranchViewData response from DB projections only. The
 * user-initiated `/sync` endpoint is the boundary that may reconcile GitHub
 * PR comments/reviews and file-change cache data.
 */
export async function getBranchViewData(
  ctx: PrContext,
  user: User,
  auth: BranchViewAuthContext = {
    authMethod: "session",
    organizationId: user.organizationId,
  }
): Promise<GetBranchViewResult> {
  const unavailableFailure = await classifyBranchViewUnavailable(ctx);
  if (unavailableFailure) {
    return branchViewErr(unavailableFailure);
  }

  const activeCtx = await healOrphanedFileCachePointer(ctx);
  const pullRequestId = activeCtx.gitHubPullRequest?.id ?? null;
  const [dbReviews, featureCtx, planCtx, dbPr, createGithubIdentity] =
    await Promise.all([
      fetchReviews(pullRequestId),
      resolveFeatureContext(activeCtx),
      resolvePlanContext(activeCtx),
      pullRequestId
        ? withDb((db) =>
            db.pullRequestDetail.findUnique({
              where: { id: pullRequestId },
              select: { reviewDecision: true },
            })
          )
        : Promise.resolve(null),
      resolveBranchViewGithubIdentity(user),
    ]);
  const commentCapabilityContext = canUseBranchViewCommentWrites(activeCtx)
    ? {
        auth,
        githubIdentity: createGithubIdentity,
      }
    : undefined;
  const dbComments = await fetchUnifiedBranchViewComments(
    activeCtx,
    user,
    commentCapabilityContext
  );
  const committedFiles = await fetchCommittedFiles(activeCtx);

  return buildResult(
    activeCtx,
    committedFiles,
    dbComments,
    dbReviews,
    dbPr,
    featureCtx,
    planCtx,
    user,
    auth,
    createGithubIdentity
  );
}

/**
 * Build a typed failure when the primary PR resolver cannot produce a renderable
 * Branch View context. The lookup is read-only and intentionally scoped to the
 * current organization so wrong-org resources collapse to a generic not-found.
 */
export async function resolveBranchViewMissingContextFailure(
  externalLinkId: string,
  organizationId: string
): Promise<BranchViewLoadFailure> {
  try {
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: {
          id: externalLinkId,
          organizationId,
          type: ArtifactType.BRANCH,
        },
        include: {
          createdBy: {
            select: {
              githubUsername: true,
            },
          },
          branch: {
            include: {
              currentPullRequestDetail: true,
              repository: {
                select: {
                  fullName: true,
                  installation: {
                    select: {
                      installationId: true,
                      organizationId: true,
                      status: true,
                    },
                  },
                },
              },
            },
          },
        },
      })
    );

    if (!artifact) {
      return linkNotFoundFailure();
    }
    if (!artifact.branch) {
      const ctx = buildUnavailablePrContext(artifact, organizationId);
      return branchViewErrFailure({
        code: BranchViewLoadErrorCode.PullRequestUnavailable,
        message: "Branch view pull request is unavailable",
        status: Status.NotFound,
        details: await buildBranchViewLoadErrorDetails(ctx),
      });
    }
    if (
      artifact.branch.repository.installation.organizationId !== null &&
      artifact.branch.repository.installation.organizationId !== organizationId
    ) {
      return linkNotFoundFailure();
    }

    const ctx = buildUnavailablePrContext(artifact, organizationId);
    return branchViewErrFailure({
      code: BranchViewLoadErrorCode.PullRequestUnavailable,
      message: "Branch view pull request is unavailable",
      status: Status.NotFound,
      details: await buildBranchViewLoadErrorDetails(ctx),
    });
  } catch (error) {
    log.error("[branch-view] resolveBranchViewMissingContextFailure failed", {
      error: parseError(error),
      externalLinkId,
      organizationId,
    });
    scheduleLogFlush();
    return branchViewErrFailure({
      code: BranchViewLoadErrorCode.TransientLoadError,
      message: "Branch view data is temporarily unavailable",
      status: Status.Error,
    });
  }
}

function branchViewOk(data: BranchViewData): GetBranchViewResult {
  return Result.ok<BranchViewData, BranchViewLoadFailure>(data);
}

function branchViewErr(failure: BranchViewLoadFailure): GetBranchViewResult {
  return Result.err<BranchViewData, BranchViewLoadFailure>(failure);
}

function branchViewErrFailure(
  failure: BranchViewLoadFailure
): BranchViewLoadFailure {
  return failure.details && Object.keys(failure.details).length > 0
    ? failure
    : {
        code: failure.code,
        message: failure.message,
        status: failure.status,
      };
}

function linkNotFoundFailure(): BranchViewLoadFailure {
  return {
    code: BranchViewLoadErrorCode.LinkNotFound,
    message: "Branch view not found",
    status: Status.NotFound,
  };
}

async function classifyBranchViewUnavailable(
  ctx: PrContext
): Promise<BranchViewLoadFailure | null> {
  const missingRenderablePullRequest =
    ctx.branch !== null &&
    !(
      ctx.gitHubPullRequest &&
      ctx.pullNumber &&
      ctx.branch?.currentPullRequestDetailId
    );
  if (
    ctx.branch?.invalidCurrentPullRequestRelation === true ||
    missingRenderablePullRequest
  ) {
    return branchViewErrFailure({
      code: BranchViewLoadErrorCode.PullRequestUnavailable,
      message: "Branch view pull request is unavailable",
      status: Status.NotFound,
      details: await buildBranchViewLoadErrorDetails(ctx),
    });
  }

  return null;
}

async function buildBranchViewLoadErrorDetails(
  ctx: PrContext
): Promise<JsonObject | undefined> {
  const [featureContext, planContext] = await Promise.all([
    resolveFeatureContext(ctx),
    resolvePlanContext(ctx),
  ]);
  const details: BranchViewLoadErrorDetails = {};
  const githubPullRequestUrl = buildCanonicalGitHubPullRequestUrl({
    candidateUrls: [
      ctx.gitHubPullRequest?.htmlUrl,
      ctx.externalLink.externalUrl,
    ],
    owner: ctx.owner,
    pullNumber: ctx.pullNumber,
    repo: ctx.repo,
  });
  if (githubPullRequestUrl) {
    details.githubPullRequestUrl = githubPullRequestUrl;
  }
  if (featureContext?.slug) {
    details.featureSlug = featureContext.slug;
  }
  if (featureContext?.title) {
    details.featureTitle = featureContext.title;
  }
  if (planContext?.slug) {
    details.producedByPlanSlug = planContext.slug;
  }
  if (planContext?.title) {
    details.producedByPlanTitle = planContext.title;
  }
  if (featureContext?.projectId) {
    details.projectId = featureContext.projectId;
  }
  if (featureContext?.projectName) {
    details.projectName = featureContext.projectName;
  }
  if (featureContext?.teamId) {
    details.teamId = featureContext.teamId;
  }
  if (featureContext?.teamName) {
    details.teamName = featureContext.teamName;
  }

  return Object.keys(details).length > 0 ? { ...details } : undefined;
}

export function buildCanonicalGitHubPullRequestUrl(input: {
  candidateUrls: (string | null | undefined)[];
  owner: string;
  repo: string;
  pullNumber: number | null;
}): string | undefined {
  if (
    !(
      isSafeGitHubPathSegment(input.owner) &&
      isSafeGitHubPathSegment(input.repo) &&
      Number.isSafeInteger(input.pullNumber)
    ) ||
    (input.pullNumber ?? 0) <= 0
  ) {
    return undefined;
  }

  for (const candidateUrl of input.candidateUrls) {
    if (
      candidateUrl &&
      matchesCanonicalGitHubPullRequestUrl(candidateUrl, {
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pullNumber,
      })
    ) {
      return `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}`;
    }
  }
  return undefined;
}

function matchesCanonicalGitHubPullRequestUrl(
  candidateUrl: string,
  identity: { owner: string; repo: string; pullNumber: number | null }
): boolean {
  try {
    const url = new URL(candidateUrl);
    const [owner, repo, pullSegment, pullNumber, ...extra] = url.pathname
      .split("/")
      .filter(Boolean);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      pullSegment === "pull" &&
      extra.length === 0 &&
      !url.search &&
      !url.hash &&
      owner.toLowerCase() === identity.owner.toLowerCase() &&
      repo.toLowerCase() === identity.repo.toLowerCase() &&
      pullNumber === String(identity.pullNumber)
    );
  } catch {
    return false;
  }
}

function isSafeGitHubPathSegment(value: string): boolean {
  return value.length > 0 && !UNSAFE_PATH_SEGMENT_PATTERN.test(value);
}

type BranchArtifactFallbackRow = {
  id: string;
  organizationId: string;
  projectId: string | null;
  name: string;
  status: string;
  externalUrl: string | null;
  createdBy: { githubUsername: string | null } | null;
  branch: {
    artifactId: string;
    repositoryId: string;
    branchName: string;
    baseBranch: string | null;
    baseBranchSource: string | null;
    headSha: string | null;
    headShaSource: string | null;
    headShaObservedAt: Date | null;
    lastPushBeforeSha: string | null;
    currentPullRequestDetailId: string | null;
    checksStatus: string | null;
    checksDetailHeadSha: string | null;
    checksDetailTotalCount: number;
    checksDetailTruncated: boolean;
    checksDetailProviderState: string | null;
    checksDetailUnavailableReason: string | null;
    checksDetailUpdatedAt: Date | null;
    fileCacheStatus: string;
    fileCacheHeadSha: string | null;
    fileCacheFileCount: number;
    fileCachePatchBytes: number;
    fileCacheUpdatedAt: Date | null;
    syncStatus: string;
    lastSyncStartedAt: Date | null;
    lastSyncCompletedAt: Date | null;
    lastSyncErrorCode: string | null;
    lastSyncErrorMessage: string | null;
    currentPullRequestDetail: {
      id: string;
      repositoryId: string;
      githubId: string;
      number: number;
      title: string | null;
      htmlUrl: string | null;
      prState: string;
      isDraft: boolean;
      reviewDecision: string | null;
      lastVerifiedAt?: Date | null;
      lastRefreshAttemptAt?: Date | null;
    } | null;
    repository: {
      fullName: string;
      installation: {
        installationId: string;
        organizationId: string | null;
        status: string;
      };
    };
  } | null;
};

function buildUnavailablePrContext(
  artifact: BranchArtifactFallbackRow,
  organizationId: string
): PrContext {
  const branch = artifact.branch;
  if (!branch) {
    return {
      externalLink: branchViewExternalLink(artifact),
      prMetadata: null,
      branch: null,
      gitHubPullRequest: null,
      repositoryId: null,
      installationId: "",
      owner: "",
      repo: "",
      pullNumber: null,
    };
  }
  if (
    branch.repository.installation.organizationId !== organizationId ||
    branch.repository.installation.status !== GitHubInstallationStatus.ACTIVE
  ) {
    const repoIdentity = parseBranchViewRepositoryFullName(
      branch.repository.fullName
    );
    return repoIdentity
      ? buildPrContextFromFallbackArtifact(artifact, repoIdentity)
      : {
          externalLink: branchViewExternalLink(artifact),
          prMetadata: null,
          branch: toPrContextBranch(branch, false),
          gitHubPullRequest: null,
          repositoryId: branch.repositoryId,
          installationId: branch.repository.installation.installationId,
          owner: "",
          repo: "",
          pullNumber: null,
        };
  }

  const repoIdentity = parseBranchViewRepositoryFullName(
    branch.repository.fullName
  );
  if (!repoIdentity) {
    return {
      externalLink: branchViewExternalLink(artifact),
      prMetadata: null,
      branch: toPrContextBranch(branch, false),
      gitHubPullRequest: null,
      repositoryId: branch.repositoryId,
      installationId: branch.repository.installation.installationId,
      owner: "",
      repo: "",
      pullNumber: null,
    };
  }

  return buildPrContextFromFallbackArtifact(artifact, repoIdentity);
}

function buildPrContextFromFallbackArtifact(
  artifact: BranchArtifactFallbackRow,
  repoIdentity: { owner: string; repo: string }
): PrContext {
  const branch = artifact.branch;
  const currentPr = branch?.currentPullRequestDetail ?? null;
  return {
    externalLink: branchViewExternalLink(artifact),
    prMetadata: currentPr
      ? {
          number: currentPr.number,
          githubId: currentPr.githubId,
          headBranch: branch?.branchName ?? "",
          baseBranch: branch?.baseBranch ?? "",
          state: currentPr.prState,
        }
      : null,
    branch: branch ? toPrContextBranch(branch, Boolean(currentPr)) : null,
    gitHubPullRequest:
      branch && currentPr
        ? {
            id: currentPr.id,
            repositoryId: currentPr.repositoryId,
            documentId: null,
            githubId: currentPr.githubId,
            headSha: branch.headSha,
            number: currentPr.number,
            title: currentPr.title,
            htmlUrl: currentPr.htmlUrl,
            baseBranch: branch.baseBranch ?? "",
            headBranch: branch.branchName,
            state: currentPr.prState,
            isDraft: currentPr.isDraft,
            checksStatus: branch.checksStatus,
            reviewDecision: currentPr.reviewDecision,
            lastVerifiedAt: currentPr.lastVerifiedAt ?? null,
            lastRefreshAttemptAt: currentPr.lastRefreshAttemptAt ?? null,
          }
        : null,
    repositoryId: branch?.repositoryId ?? null,
    installationId: branch?.repository.installation.installationId ?? "",
    owner: repoIdentity.owner,
    repo: repoIdentity.repo,
    pullNumber: currentPr?.number ?? null,
  };
}

function branchViewExternalLink(artifact: BranchArtifactFallbackRow) {
  return {
    id: artifact.id,
    title: artifact.name,
    externalUrl: artifact.externalUrl ?? "",
    status: artifact.status,
    metadata: null,
    projectId: artifact.projectId,
    organizationId: artifact.organizationId,
    createdBy: artifact.createdBy,
  };
}

function toPrContextBranch(
  branch: NonNullable<BranchArtifactFallbackRow["branch"]>,
  hasValidCurrentPr: boolean
): NonNullable<PrContext["branch"]> {
  return {
    artifactId: branch.artifactId,
    repositoryId: branch.repositoryId,
    branchName: branch.branchName,
    baseBranch: branch.baseBranch,
    baseBranchSource: branch.baseBranchSource,
    headSha: branch.headSha,
    headShaSource: branch.headShaSource,
    headShaObservedAt: branch.headShaObservedAt,
    lastPushBeforeSha: branch.lastPushBeforeSha,
    currentPullRequestDetailId: hasValidCurrentPr
      ? branch.currentPullRequestDetailId
      : null,
    checksStatus: branch.checksStatus,
    checksDetailHeadSha: branch.checksDetailHeadSha,
    checksDetailTotalCount: branch.checksDetailTotalCount,
    checksDetailTruncated: branch.checksDetailTruncated,
    checksDetailProviderState: branch.checksDetailProviderState,
    checksDetailUnavailableReason: branch.checksDetailUnavailableReason,
    checksDetailUpdatedAt: branch.checksDetailUpdatedAt,
    statusChecks: [],
    fileCacheStatus: branch.fileCacheStatus,
    fileCacheHeadSha: branch.fileCacheHeadSha,
    fileCacheFileCount: branch.fileCacheFileCount,
    fileCachePatchBytes: branch.fileCachePatchBytes,
    fileCacheUpdatedAt: branch.fileCacheUpdatedAt,
    syncStatus: branch.syncStatus,
    lastSyncStartedAt: branch.lastSyncStartedAt,
    lastSyncCompletedAt: branch.lastSyncCompletedAt,
    lastSyncErrorCode: branch.lastSyncErrorCode,
    lastSyncErrorMessage: branch.lastSyncErrorMessage,
    ...(branch.currentPullRequestDetail && !hasValidCurrentPr
      ? { invalidCurrentPullRequestRelation: true }
      : {}),
  };
}

function parseBranchViewRepositoryFullName(
  fullName: string
): { owner: string; repo: string } | null {
  const [owner, repo, ...extra] = fullName.split("/");
  if (!(owner && repo) || extra.length > 0) {
    return null;
  }
  return { owner, repo };
}

/**
 * Heal a branch whose file-cache pointer references a head SHA with no
 * materialized file rows. This happens when the branch head advances without a
 * webhook-driven cache refresh (e.g. local dev with GitHub webhooks disabled):
 * the served diff and `expectedHeadSha` point at an empty cache, so every inline
 * comment anchor validates against zero rows and fails with AnchorNotInDiff.
 *
 * The refresh runs on read (before the diff is served) so the client receives a
 * consistent diff and head SHA up front. We never heal at write time, which
 * would change line numbers under an in-progress comment. The refresh is
 * self-throttled via startBranchSync, and only fires when the pointer is behind
 * the head AND has no rows — a stale-but-consistent cache is left untouched.
 */
async function healOrphanedFileCachePointer(
  ctx: PrContext
): Promise<PrContext> {
  if (
    ctx.credentialSource === BranchViewContextCredentialSource.ActiveSibling
  ) {
    return ctx;
  }

  const branch = ctx.branch;
  const pointer = branch?.fileCacheHeadSha;
  if (!(branch && pointer) || pointer === branch.headSha) {
    return ctx;
  }

  const organizationId = ctx.externalLink.organizationId;
  const pointerRowCount = await withDb((db) =>
    db.branchFileChange.count({
      where: { branchArtifactId: branch.artifactId, headSha: pointer },
    })
  );
  if (pointerRowCount > 0) {
    return ctx;
  }

  try {
    const refresh = await refreshBranchFileChangeCache(branch.artifactId, {
      organizationId,
    });
    if (!refresh.ok) {
      return ctx;
    }

    const refreshed = await resolvePrContext(
      ctx.externalLink.id,
      organizationId
    );
    return refreshed ?? ctx;
  } catch (error) {
    log.warn("[branch-view] Failed to heal orphaned file-cache pointer", {
      error,
      externalLinkId: ctx.externalLink.id,
      branchArtifactId: branch.artifactId,
      fileCacheHeadSha: pointer,
      headSha: branch.headSha,
    });
    return ctx;
  }
}

// --- API response type aliases ---

type ApiInlineComment = NonNullable<
  Extract<
    Awaited<ReturnType<typeof listPullRequestReviewCommentsWithProviderResult>>,
    { status: typeof GitHubProviderResultStatus.Success }
  >["value"]
>[number];
type ApiGeneralComment = NonNullable<
  Extract<
    Awaited<ReturnType<typeof listPullRequestIssueCommentsWithProviderResult>>,
    { status: typeof GitHubProviderResultStatus.Success }
  >["value"]
>[number];
type ApiReview = NonNullable<
  Extract<
    Awaited<ReturnType<typeof listPullRequestReviewsWithProviderResult>>,
    { status: typeof GitHubProviderResultStatus.Success }
  >["value"]
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
  committedFiles: BranchViewFile[],
  comments: BranchViewComment[],
  reviews: BranchViewReview[],
  dbPr: { reviewDecision: string | null } | null,
  featureContext: FeatureContext | null,
  planContext: PlanContext | null,
  user: User,
  auth: BranchViewAuthContext,
  createGithubIdentity: {
    status: BranchViewGithubIdentityStatus;
    githubUserId?: string | null;
    login?: string | null;
  }
): GetBranchViewResult {
  const { owner, repo } = ctx;
  const currentPr = ctx.gitHubPullRequest;
  const branch = ctx.branch;
  const authorLogin = ctx.externalLink.createdBy?.githubUsername ?? null;
  const isAuthor = Boolean(
    authorLogin &&
      user.githubUsername &&
      normalizeGitHubLogin(authorLogin) ===
        normalizeGitHubLogin(user.githubUsername)
  );
  const prState = mapPrState(
    currentPr?.state ?? ctx.prMetadata?.state ?? ctx.externalLink.status
  );
  const prLifecycleRepair = getBranchViewPrLifecycleRepair(ctx);
  const commentWritableBranch = getBranchViewCommentWritableBranch(ctx);
  const canCreateConversationComment = canCreateConversationFromBranchView({
    auth,
    branch: commentWritableBranch,
    githubIdentity: createGithubIdentity,
    organizationId: ctx.externalLink.organizationId,
  });
  const canCreateInlineComment = canCreateInlineFromBranchView({
    auth,
    branch: commentWritableBranch,
    githubIdentity: createGithubIdentity,
    organizationId: ctx.externalLink.organizationId,
  });
  const commentPromptEligibility = buildBranchViewCreatePromptEligibility({
    auth,
    branch: commentWritableBranch,
    githubIdentity: createGithubIdentity,
    organizationId: ctx.externalLink.organizationId,
  });

  const data: BranchViewData = {
    externalLinkId: ctx.externalLink.id,
    branch: buildBranchProjection(ctx),
    currentPullRequest: buildCurrentPullRequestProjection(ctx, dbPr),
    prTitle: currentPr?.title ?? ctx.externalLink.title,
    externalUrl: ctx.externalLink.externalUrl,
    prNumber: currentPr?.number ?? ctx.prMetadata?.number ?? 0,
    prHtmlUrl: currentPr?.htmlUrl ?? "",
    featureSlug: featureContext?.slug ?? null,
    featureTitle: featureContext?.title ?? null,
    teamId: featureContext?.teamId ?? null,
    teamName: featureContext?.teamName ?? null,
    projectId: ctx.externalLink.projectId,
    projectName: featureContext?.projectName ?? null,
    headBranch: branch?.branchName ?? currentPr?.headBranch ?? "",
    baseBranch: branch?.baseBranch ?? currentPr?.baseBranch ?? "",
    headSha: branch?.headSha ?? currentPr?.headSha ?? null,
    prState,
    prLifecycleRepair: { status: prLifecycleRepair.status },
    syncState: buildBranchViewSyncState(ctx, prLifecycleRepair.status),
    reviewDecision: mapReviewDecision(dbPr?.reviewDecision ?? undefined),
    checksStatus: mapChecksStatus(branch?.checksStatus ?? null),
    checks: branch ? projectBranchStatusChecks(branch) : undefined,
    isDraft: currentPr?.isDraft ?? false,
    authorLogin,
    isAuthor,
    canCreateConversationComment,
    canCreateInlineComment,
    commentWriteIdentity: { status: createGithubIdentity.status },
    commentPromptEligibility,
    repoFullName: `${owner}/${repo}`,
    committedFiles,
    reviews,
    comments,
    producedByPlanSlug: planContext?.slug ?? null,
    producedByPlanTitle: planContext?.title ?? null,
  };

  scheduleBranchViewPrLifecycleRepair(
    prLifecycleRepair,
    ctx.externalLink.organizationId
  );

  return branchViewOk(data);
}

function getBranchViewCommentWritableBranch(
  ctx: PrContext
): PrContext["branch"] {
  if (!canUseBranchViewCommentWrites(ctx)) {
    return null;
  }
  return ctx.branch;
}

/**
 * Active-sibling credentials are a render/read recovery path only. Comment
 * mutation routes still resolve the pinned repository, so Branch View must not
 * expose write affordances until the branch is relinked to an active pinned
 * repository.
 */
function canUseBranchViewCommentWrites(ctx: PrContext): boolean {
  return (
    ctx.credentialSource !== BranchViewContextCredentialSource.ActiveSibling
  );
}

function canCreateConversationFromBranchView(input: {
  auth: BranchViewAuthContext;
  branch: PrContext["branch"];
  githubIdentity: {
    status: BranchViewGithubIdentityStatus;
    githubUserId?: string | null;
    login?: string | null;
  };
  organizationId: string;
}): boolean {
  if (!(input.branch?.artifactId && input.branch.currentPullRequestDetailId)) {
    return false;
  }

  return canPerformBranchViewCommentAction({
    action: BranchViewCommentAction.CreateConversation,
    auth: input.auth,
    githubIdentity: input.githubIdentity,
    target: { organizationId: input.organizationId },
  }).allowed;
}

function buildBranchViewCreatePromptEligibility(input: {
  auth: BranchViewAuthContext;
  branch: PrContext["branch"];
  githubIdentity: {
    status: BranchViewGithubIdentityStatus;
    githubUserId?: string | null;
    login?: string | null;
  };
  organizationId: string;
}) {
  return buildCreatePromptEligibility({
    auth: input.auth,
    branchReady: Boolean(
      input.branch?.artifactId && input.branch.currentPullRequestDetailId
    ),
    githubIdentity: input.githubIdentity,
    organizationId: input.organizationId,
  });
}

function canCreateInlineFromBranchView(input: {
  auth: BranchViewAuthContext;
  branch: PrContext["branch"];
  githubIdentity: {
    status: BranchViewGithubIdentityStatus;
    githubUserId?: string | null;
    login?: string | null;
  };
  organizationId: string;
}): boolean {
  if (!(input.branch?.artifactId && input.branch.currentPullRequestDetailId)) {
    return false;
  }

  return canPerformBranchViewCommentAction({
    action: BranchViewCommentAction.CreateInline,
    auth: input.auth,
    githubIdentity: input.githubIdentity,
    target: { organizationId: input.organizationId },
  }).allowed;
}

async function resolveBranchViewGithubIdentity(user: User): Promise<{
  status: BranchViewGithubIdentityStatus;
  githubUserId?: string | null;
  login?: string | null;
}> {
  const identity = await getGitHubWriteIdentityStatus({
    organizationId: user.organizationId,
    userId: user.id,
    now: new Date(),
  });
  if (!identity.ok) {
    return { status: identity.error.identityBlocker.status };
  }
  return {
    status: BranchViewGithubIdentityStatus.Active,
    githubUserId: identity.value.githubUserId,
    login: identity.value.login,
  };
}

function buildBranchProjection(ctx: PrContext): BranchViewBranch | null {
  const branch = ctx.branch;
  if (!branch) {
    return null;
  }
  return {
    artifactId: branch.artifactId,
    branchName: branch.branchName,
    baseBranch: branch.baseBranch,
    baseBranchSource: branch.baseBranchSource,
    headSha: branch.headSha,
    headShaSource: branch.headShaSource,
    headShaObservedAt: isoOrNull(branch.headShaObservedAt),
    lastPushBeforeSha: branch.lastPushBeforeSha,
    checksStatus: mapChecksStatus(branch.checksStatus),
    fileCacheStatus: branch.fileCacheStatus,
    fileCacheHeadSha: branch.fileCacheHeadSha,
    fileCacheFileCount: branch.fileCacheFileCount,
    fileCachePatchBytes: branch.fileCachePatchBytes,
    fileCacheUpdatedAt: isoOrNull(branch.fileCacheUpdatedAt),
    syncStatus: branch.syncStatus,
    lastSyncStartedAt: isoOrNull(branch.lastSyncStartedAt),
    lastSyncCompletedAt: isoOrNull(branch.lastSyncCompletedAt),
    lastSyncErrorCode: branch.lastSyncErrorCode,
    lastSyncErrorMessage: branch.lastSyncErrorMessage,
  };
}

function buildCurrentPullRequestProjection(
  ctx: PrContext,
  dbPr: { reviewDecision: string | null } | null
): BranchViewCurrentPullRequest | null {
  const currentPr = ctx.gitHubPullRequest;
  const branch = ctx.branch;
  if (!currentPr) {
    return null;
  }
  return {
    id: currentPr.id,
    githubId: currentPr.githubId,
    number: currentPr.number,
    title: currentPr.title,
    htmlUrl: currentPr.htmlUrl,
    headBranch: branch?.branchName ?? currentPr.headBranch,
    baseBranch: branch?.baseBranch ?? currentPr.baseBranch,
    headSha: branch?.headSha ?? currentPr.headSha,
    state: mapPrState(currentPr.state),
    isDraft: currentPr.isDraft,
    checksStatus: mapChecksStatus(branch?.checksStatus ?? null),
    reviewDecision: mapReviewDecision(
      dbPr?.reviewDecision ?? currentPr.reviewDecision
    ),
  };
}

function buildBranchViewSyncState(
  ctx: PrContext,
  repairStatus: BranchViewPrLifecycleRepairStatus
): BranchViewSyncState {
  const lifecycleLastSyncedAt = isoOrNull(
    ctx.gitHubPullRequest?.lastVerifiedAt ?? null
  );
  const lifecycleLastAttemptedAt = isoOrNull(
    ctx.gitHubPullRequest?.lastRefreshAttemptAt ?? null
  );
  const branchLastAttemptedAt = isoOrNull(
    ctx.branch?.lastSyncStartedAt ?? ctx.branch?.lastSyncCompletedAt ?? null
  );
  const branchLastSyncedAt = getBranchLastSuccessfulSyncAt(ctx);
  const inProgress = isBranchViewSyncInProgress(ctx, repairStatus);
  const presentation = getBranchViewSyncPresentation({
    branchLastSyncedAt,
    ctx,
    inProgress,
    lifecycleLastSyncedAt,
    repairStatus,
  });
  const lastOutcome = buildBranchViewSyncOutcome({
    branchLastSyncedAt,
    ctx,
    inProgress,
    lifecycleLastSyncedAt,
  });
  const latestSuccessfulSyncAt = latestIso([
    lifecycleLastSyncedAt,
    branchLastSyncedAt,
  ]);
  const latestAttemptedAt = latestIso([
    lifecycleLastAttemptedAt,
    branchLastAttemptedAt,
  ]);

  return {
    lifecycleLastSyncedAt,
    lifecycleLastAttemptedAt,
    branchLastSyncedAt,
    branchLastAttemptedAt,
    inProgress,
    presentation,
    backgroundRefreshAfterAt: inProgress
      ? null
      : buildBackgroundRefreshAfterAt({
          isSyncable: Boolean(ctx.branch),
          latestAttemptedAt,
          latestSuccessfulSyncAt,
          presentation,
        }),
    lastOutcome,
  };
}

function getBranchLastSuccessfulSyncAt(ctx: PrContext): string | null {
  const branch = ctx.branch;
  if (!branch) {
    return null;
  }
  if (!branch.lastSyncErrorCode && branch.lastSyncCompletedAt) {
    return isoOrNull(branch.lastSyncCompletedAt);
  }
  return isoOrNull(branch.fileCacheUpdatedAt);
}

function latestIso(values: (string | null)[]): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (value && (!latest || value > latest)) {
      latest = value;
    }
  }
  return latest;
}

function buildBackgroundRefreshAfterAt(input: {
  isSyncable: boolean;
  latestAttemptedAt: string | null;
  latestSuccessfulSyncAt: string | null;
  presentation: BranchViewSyncPresentationState;
}): string | null {
  if (!input.isSyncable) {
    return null;
  }
  const staleEligibleAt = input.latestSuccessfulSyncAt
    ? new Date(input.latestSuccessfulSyncAt).getTime() +
      BRANCH_VIEW_BACKGROUND_STALE_MS
    : null;
  const attemptEligibleAt = input.latestAttemptedAt
    ? new Date(input.latestAttemptedAt).getTime() +
      BRANCH_VIEW_IN_FLIGHT_STALE_MS
    : Date.now();
  const presentationNeedsRefresh =
    input.presentation === BranchViewSyncPresentationState.Unknown ||
    input.presentation === BranchViewSyncPresentationState.Failed ||
    input.presentation === BranchViewSyncPresentationState.ShowingLastKnown;
  if (!(staleEligibleAt || presentationNeedsRefresh)) {
    return null;
  }
  return new Date(
    Math.max(staleEligibleAt ?? Number.NEGATIVE_INFINITY, attemptEligibleAt)
  ).toISOString();
}

function isBranchViewSyncInProgress(
  ctx: PrContext,
  repairStatus: BranchViewPrLifecycleRepairStatus
): boolean {
  return (
    repairStatus === BranchViewPrLifecycleRepairStatus.Pending ||
    isBranchSyncRecentlyStarted(ctx.branch)
  );
}

function isBranchSyncRecentlyStarted(branch: PrContext["branch"]): boolean {
  if (branch?.syncStatus !== BranchSyncStatus.Syncing) {
    return false;
  }
  const startedAt = branch.lastSyncStartedAt?.getTime();
  if (!startedAt) {
    return false;
  }
  // A serverless sync can terminate after setting Syncing. Once the throttle
  // window expires, project it as settled so the client can retry/refetch.
  return Date.now() - startedAt < BRANCH_VIEW_IN_FLIGHT_STALE_MS;
}

function getBranchViewSyncPresentation(input: {
  branchLastSyncedAt: string | null;
  ctx: PrContext;
  inProgress: boolean;
  lifecycleLastSyncedAt: string | null;
  repairStatus: BranchViewPrLifecycleRepairStatus;
}): BranchViewSyncPresentationState {
  if (input.inProgress) {
    return BranchViewSyncPresentationState.Refreshing;
  }

  const rawCode = getProjectedSyncErrorCode(input.ctx);
  if (rawCode) {
    const source = classifyBranchSyncOutcomeSource(rawCode);
    if (
      source === BranchViewSyncOutcomeSource.PullRequestLifecycle &&
      input.lifecycleLastSyncedAt
    ) {
      return BranchViewSyncPresentationState.ShowingLastKnown;
    }
    if (
      source === BranchViewSyncOutcomeSource.FileCache ||
      source === BranchViewSyncOutcomeSource.Comments
    ) {
      return BranchViewSyncPresentationState.Failed;
    }
    return input.lifecycleLastSyncedAt || input.branchLastSyncedAt
      ? BranchViewSyncPresentationState.ShowingLastKnown
      : BranchViewSyncPresentationState.Failed;
  }

  if (input.lifecycleLastSyncedAt || input.branchLastSyncedAt) {
    return BranchViewSyncPresentationState.Fresh;
  }
  return BranchViewSyncPresentationState.Unknown;
}

function buildBranchViewSyncOutcome(input: {
  branchLastSyncedAt: string | null;
  ctx: PrContext;
  inProgress: boolean;
  lifecycleLastSyncedAt: string | null;
}): BranchViewSyncOutcome {
  if (input.inProgress) {
    return emptyBranchViewSyncOutcome();
  }

  const rawCode = getProjectedSyncErrorCode(input.ctx);
  if (rawCode) {
    const code = mapBranchViewSyncErrorCode(rawCode) ?? rawCode;
    return {
      synced: false,
      code,
      message: getBranchViewSyncOutcomeMessage(code),
      httpStatus: getBranchViewSyncOutcomeHttpStatus(code),
      retryAfterSeconds: null,
      source: classifyBranchSyncOutcomeSource(code),
    };
  }

  if (input.lifecycleLastSyncedAt || input.branchLastSyncedAt) {
    return {
      synced: true,
      code: null,
      message: null,
      httpStatus: null,
      retryAfterSeconds: null,
      source: null,
    };
  }

  return emptyBranchViewSyncOutcome();
}

function emptyBranchViewSyncOutcome(): BranchViewSyncOutcome {
  return {
    synced: null,
    code: null,
    message: null,
    httpStatus: null,
    retryAfterSeconds: null,
    source: null,
  };
}

function getProjectedSyncErrorCode(ctx: PrContext): string | null {
  if (ctx.branch?.lastSyncErrorCode) {
    return ctx.branch.lastSyncErrorCode;
  }
  return ctx.branch?.fileCacheStatus === BranchFileCacheStatus.Failed
    ? BranchViewSyncErrorCode.FileCacheRefreshFailed
    : null;
}

function mapBranchViewSyncErrorCode(code: string | null): string | null {
  switch (code) {
    case BranchViewSyncErrorCode.SyncThrottled:
    case BranchViewSyncErrorCode.CurrentPullRequestStale:
    case BranchViewSyncErrorCode.PrLifecycleUnavailable:
    case BranchViewSyncErrorCode.PrLifecycleGuardFailed:
    case BranchViewSyncErrorCode.FileCacheRefreshFailed:
    case BranchViewSyncErrorCode.PrSyncFailed:
    case BranchViewFileCacheSyncErrorCode.MissingCompareRefs:
    case BranchViewFileCacheSyncErrorCode.CompareFailed:
      return code;
    default:
      return null;
  }
}

function classifyBranchSyncOutcomeSource(
  code: string | null
): BranchViewSyncOutcome["source"] {
  if (
    code === BranchViewSyncErrorCode.CurrentPullRequestStale ||
    code === BranchViewSyncErrorCode.PrLifecycleUnavailable ||
    code === BranchViewSyncErrorCode.PrLifecycleGuardFailed
  ) {
    return BranchViewSyncOutcomeSource.PullRequestLifecycle;
  }
  if (code === BranchViewSyncErrorCode.FileCacheRefreshFailed) {
    return BranchViewSyncOutcomeSource.FileCache;
  }
  if (
    code === BranchViewFileCacheSyncErrorCode.MissingCompareRefs ||
    code === BranchViewFileCacheSyncErrorCode.CompareFailed
  ) {
    return BranchViewSyncOutcomeSource.FileCache;
  }
  if (code === BranchViewSyncErrorCode.PrSyncFailed) {
    return BranchViewSyncOutcomeSource.Comments;
  }
  return BranchViewSyncOutcomeSource.BranchSync;
}

function getBranchViewSyncOutcomeHttpStatus(
  code: string | null
): BranchViewSyncOutcome["httpStatus"] {
  switch (code) {
    case BranchViewSyncErrorCode.SyncThrottled:
      return 429;
    case BranchViewSyncErrorCode.CurrentPullRequestStale:
    case BranchViewSyncErrorCode.PrLifecycleGuardFailed:
      return 409;
    case BranchViewSyncErrorCode.PrLifecycleUnavailable:
      return 502;
    case BranchViewSyncErrorCode.FileCacheRefreshFailed:
    case BranchViewFileCacheSyncErrorCode.CompareFailed:
      return 500;
    case BranchViewSyncErrorCode.PrSyncFailed:
      return null;
    case BranchViewFileCacheSyncErrorCode.MissingCompareRefs:
      return 400;
    default:
      return null;
  }
}

function getBranchViewSyncOutcomeMessage(code: string | null): string | null {
  switch (code) {
    case BranchViewSyncErrorCode.SyncThrottled:
      return "Rate limited. Try again later.";
    case BranchViewSyncErrorCode.CurrentPullRequestStale:
    case BranchViewSyncErrorCode.PrLifecycleGuardFailed:
      return "Refreshing PR status. Showing last-known data.";
    case BranchViewSyncErrorCode.PrLifecycleUnavailable:
      return "Could not reach GitHub. Showing last-known PR status.";
    case BranchViewSyncErrorCode.FileCacheRefreshFailed:
      return "Could not refresh file changes. Showing last-known files when available.";
    case BranchViewSyncErrorCode.PrSyncFailed:
      return "Could not sync PR comments from GitHub.";
    case BranchViewFileCacheSyncErrorCode.MissingCompareRefs:
      return "File comparison is unavailable for this branch.";
    case BranchViewFileCacheSyncErrorCode.CompareFailed:
      return "Could not refresh file changes from GitHub.";
    default:
      return code ? "Sync did not complete. Showing last-known data." : null;
  }
}

type BranchViewPrLifecycleRepairDecision = {
  status: NonNullable<BranchViewData["prLifecycleRepair"]>["status"];
  input: PrReadRepairInput | null;
  shouldSchedule: boolean;
  nowMs: number;
};

function getBranchViewPrLifecycleRepair(
  ctx: PrContext
): BranchViewPrLifecycleRepairDecision {
  if (
    ctx.credentialSource === BranchViewContextCredentialSource.ActiveSibling
  ) {
    return {
      status: BranchViewPrLifecycleRepairStatus.Idle,
      input: null,
      shouldSchedule: false,
      nowMs: Date.now(),
    };
  }

  const input = buildBranchViewPrReadRepairInput(ctx);
  const nowMs = Date.now();
  if (!input) {
    return {
      status: BranchViewPrLifecycleRepairStatus.Idle,
      input: null,
      shouldSchedule: false,
      nowMs,
    };
  }

  return {
    status: getPrReadRepairStatus(input, nowMs),
    input,
    shouldSchedule: isPrReadRepairEligible(input, nowMs),
    nowMs,
  };
}

function buildBranchViewPrReadRepairInput(
  ctx: PrContext
): PrReadRepairInput | null {
  const currentPr = ctx.gitHubPullRequest;
  const branch = ctx.branch;
  if (!(branch && currentPr && ctx.pullNumber)) {
    return null;
  }

  const externalUrl =
    currentPr.htmlUrl ||
    `https://github.com/${ctx.owner}/${ctx.repo}/pull/${ctx.pullNumber}`;

  return {
    id: branch.artifactId,
    externalUrl,
    projectId: ctx.externalLink.projectId,
    organizationId: ctx.externalLink.organizationId,
    prState: mapPrState(currentPr.state),
    lastVerifiedAt: currentPr.lastVerifiedAt ?? null,
    lastRefreshAttemptAt: currentPr.lastRefreshAttemptAt ?? null,
  };
}

function scheduleBranchViewPrLifecycleRepair(
  decision: BranchViewPrLifecycleRepairDecision,
  organizationId: string
): void {
  if (!(decision.shouldSchedule && decision.input)) {
    return;
  }

  schedulePrReadRepair([decision.input], organizationId, decision.nowMs);
}

/** Fetch the canonical unified branch-view GitHub comment projection. */
export async function fetchUnifiedBranchViewComments(
  ctx: PrContext,
  user: User,
  capabilityContext?: {
    auth: BranchViewAuthContext;
    githubIdentity: {
      status: BranchViewGithubIdentityStatus;
      githubUserId?: string | null;
      login?: string | null;
    };
  }
): Promise<BranchViewComment[]> {
  const branchArtifactId = ctx.branch?.artifactId ?? null;
  const pullRequestDetailId = ctx.branch?.currentPullRequestDetailId ?? null;
  if (!(branchArtifactId && pullRequestDetailId)) {
    return [];
  }

  const rows = await withDb((db) =>
    db.commentThread.findMany({
      where: {
        organizationId: user.organizationId,
        artifactId: branchArtifactId,
        source: ThreadSource.GITHUB,
        githubProjection: {
          is: {
            branchArtifactId,
            pullRequestDetailId,
            deletedAt: null,
          },
        },
        comments: {
          some: {
            deletedAt: null,
            githubProjection: {
              is: {
                githubCommentId: { not: null },
                githubDeletedAt: null,
              },
            },
          },
        },
      },
      select: {
        id: true,
        source: true,
        status: true,
        createdAt: true,
        githubProjection: {
          select: {
            threadKind: true,
            reviewThreadId: true,
            reviewId: true,
            htmlUrl: true,
            path: true,
            line: true,
            commitSha: true,
            side: true,
            startLine: true,
            startSide: true,
            resolvable: true,
            legacyState: true,
          },
        },
        comments: {
          where: {
            deletedAt: null,
            githubProjection: {
              is: {
                githubCommentId: { not: null },
                githubDeletedAt: null,
              },
            },
          },
          select: {
            id: true,
            authorId: true,
            body: true,
            plainText: true,
            createdAt: true,
            githubProjection: {
              select: {
                githubCommentId: true,
                githubInReplyToCommentId: true,
                githubHtmlUrl: true,
                externalAuthor: {
                  select: {
                    providerUserId: true,
                    providerLogin: true,
                    avatarUrl: true,
                    profileUrl: true,
                  },
                },
              },
            },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
    })
  );

  const authorIds = [
    ...new Set(
      rows.flatMap((row) => row.comments.map((comment) => comment.authorId))
    ),
  ];
  const authors = await loadUnifiedCommentAuthors(
    user.organizationId,
    authorIds
  );

  return rows.sort(compareUnifiedThreadRows).flatMap((row) =>
    row.comments.flatMap((comment) => {
      if (!(row.githubProjection && comment.githubProjection)) {
        return [];
      }

      const mapped = toBranchViewComment({
        thread: {
          id: row.id,
          source: row.source,
          status: row.status,
          legacyState: row.githubProjection.legacyState,
          threadKind: row.githubProjection.threadKind,
          reviewId: row.githubProjection.reviewId,
          htmlUrl: row.githubProjection.htmlUrl,
          path: row.githubProjection.path,
          line: row.githubProjection.line,
          commitSha: row.githubProjection.commitSha,
          side: row.githubProjection.side,
          startLine: row.githubProjection.startLine,
          startSide: row.githubProjection.startSide,
          resolvable: row.githubProjection.resolvable,
        },
        comment: {
          id: comment.id,
          body: comment.body,
          plainText: comment.plainText,
          createdAt: comment.createdAt,
          githubCommentId: comment.githubProjection.githubCommentId,
          githubInReplyToCommentId:
            comment.githubProjection.githubInReplyToCommentId,
          githubHtmlUrl: comment.githubProjection.githubHtmlUrl,
        },
        author:
          exactExternalAuthorDisplay(comment.githubProjection.externalAuthor) ??
          authors.get(comment.authorId) ??
          unknownGithubAuthorDisplay(),
      });

      return mapped
        ? [
            applyUnifiedCommentCapabilities(mapped, {
              capabilityContext,
              organizationId: user.organizationId,
              authorGithubUserId:
                comment.githubProjection.externalAuthor?.providerUserId ?? null,
              authorLogin:
                comment.githubProjection.externalAuthor?.providerLogin ?? null,
              reviewThreadNodeId: row.githubProjection.reviewThreadId,
            }),
          ]
        : [];
    })
  );
}

/**
 * Attach write-action hints to unified comments using the same policy as
 * mutation routes. Issue comments keep conversation edit/delete behavior, while
 * review comments expose reply/edit/delete affordances from server-owned state.
 */
function applyUnifiedCommentCapabilities(
  comment: BranchViewComment,
  input: {
    capabilityContext:
      | {
          auth: BranchViewAuthContext;
          githubIdentity: {
            status: BranchViewGithubIdentityStatus;
            githubUserId?: string | null;
            login?: string | null;
          };
        }
      | undefined;
    organizationId: string;
    authorGithubUserId: string | null;
    authorLogin: string | null;
    reviewThreadNodeId: string | null;
  }
): BranchViewComment {
  if (!input.capabilityContext) {
    return comment;
  }

  const target = {
    organizationId: input.organizationId,
    kind: comment.kind,
    authorGithubUserId: input.authorGithubUserId,
    authorLogin: input.authorLogin,
    isAppAuthored: comment.authorKind === PrCommentAuthorKind.Bot,
    reviewThreadNodeId: input.reviewThreadNodeId,
    resolvable: comment.resolvable,
    resolved: comment.resolved,
  };

  const canEdit = canPerformBranchViewCommentAction({
    action: BranchViewCommentAction.Edit,
    auth: input.capabilityContext.auth,
    githubIdentity: input.capabilityContext.githubIdentity,
    target,
  }).allowed;
  const canDelete = canPerformBranchViewCommentAction({
    action: BranchViewCommentAction.Delete,
    auth: input.capabilityContext.auth,
    githubIdentity: input.capabilityContext.githubIdentity,
    target,
  }).allowed;
  const actionPromptEligibility = buildActionPromptEligibility({
    auth: input.capabilityContext.auth,
    githubIdentity: input.capabilityContext.githubIdentity,
    target,
  });

  if (comment.kind === CommentKind.ReviewComment) {
    return {
      ...comment,
      canReply: canPerformBranchViewCommentAction({
        action: BranchViewCommentAction.Reply,
        auth: input.capabilityContext.auth,
        githubIdentity: input.capabilityContext.githubIdentity,
        target,
      }).allowed,
      canEdit,
      canDelete,
      canResolve: canPerformBranchViewCommentAction({
        action: BranchViewCommentAction.Resolve,
        auth: input.capabilityContext.auth,
        githubIdentity: input.capabilityContext.githubIdentity,
        target,
      }).allowed,
      canUnresolve: canPerformBranchViewCommentAction({
        action: BranchViewCommentAction.Unresolve,
        auth: input.capabilityContext.auth,
        githubIdentity: input.capabilityContext.githubIdentity,
        target,
      }).allowed,
      actionPromptEligibility,
    };
  }

  if (comment.kind === CommentKind.IssueComment) {
    return { ...comment, canEdit, canDelete, actionPromptEligibility };
  }

  return comment;
}

type UnifiedThreadRow = {
  id: string;
  createdAt: Date;
  githubProjection: {
    path: string | null;
    line: number | null;
  } | null;
};

function compareUnifiedThreadRows(a: UnifiedThreadRow, b: UnifiedThreadRow) {
  const pathComparison = compareNullableStringsLast(
    a.githubProjection?.path ?? null,
    b.githubProjection?.path ?? null
  );
  if (pathComparison !== 0) {
    return pathComparison;
  }

  const lineComparison = compareNullableNumbersLast(
    a.githubProjection?.line ?? null,
    b.githubProjection?.line ?? null
  );
  if (lineComparison !== 0) {
    return lineComparison;
  }

  const createdAtComparison = a.createdAt.getTime() - b.createdAt.getTime();
  return createdAtComparison === 0
    ? a.id.localeCompare(b.id)
    : createdAtComparison;
}

function compareNullableStringsLast(a: string | null, b: string | null) {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a.localeCompare(b);
}

function compareNullableNumbersLast(a: number | null, b: number | null) {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a - b;
}

async function loadUnifiedCommentAuthors(
  organizationId: string,
  authorIds: string[]
): Promise<Map<string, GitHubAuthorDisplay>> {
  if (authorIds.length === 0) {
    return new Map();
  }

  return await withDb(async (db) => {
    const users = await db.user.findMany({
      where: {
        organizationId,
        id: { in: authorIds },
      },
      select: {
        id: true,
        avatarUrl: true,
        githubUsername: true,
      },
    });

    const authorByUserId = new Map<string, GitHubAuthorDisplay>();

    for (const fallbackUser of users) {
      const fallbackDisplay = fallbackAuthorDisplay(fallbackUser);
      if (!fallbackDisplay) {
        continue;
      }
      authorByUserId.set(fallbackUser.id, fallbackDisplay);
    }

    return authorByUserId;
  });
}

type GitHubAuthorDisplay = {
  login: string;
  avatarUrl: string | null;
  profileUrl: string | null;
};

function exactExternalAuthorDisplay(
  author: {
    providerLogin: string;
    avatarUrl: string | null;
    profileUrl: string | null;
  } | null
): GitHubAuthorDisplay | null {
  if (!author) {
    return null;
  }

  return {
    login: author.providerLogin,
    avatarUrl: author.avatarUrl,
    profileUrl: author.profileUrl,
  };
}

function fallbackAuthorDisplay(user: {
  avatarUrl: string | null;
  githubUsername: string | null;
}): GitHubAuthorDisplay | null {
  if (!user.githubUsername) {
    return null;
  }

  return {
    login: user.githubUsername,
    avatarUrl: user.avatarUrl,
    profileUrl: `https://github.com/${user.githubUsername}`,
  };
}

function unknownGithubAuthorDisplay(): GitHubAuthorDisplay {
  return {
    login: "unknown-github-user",
    avatarUrl: null,
    profileUrl: null,
  };
}

async function fetchReviews(
  pullRequestId: string | null
): Promise<BranchViewReview[]> {
  if (!pullRequestId) {
    return [];
  }

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

async function fetchCommittedFiles(ctx: PrContext): Promise<BranchViewFile[]> {
  if (!ctx.branch) {
    return [];
  }
  const branchArtifactId = ctx.branch.artifactId;
  const fileCacheHeadSha = ctx.branch.fileCacheHeadSha;

  const rows = await withDb((db) =>
    db.branchFileChange.findMany({
      where: {
        branchArtifactId,
        ...(fileCacheHeadSha ? { headSha: fileCacheHeadSha } : {}),
      },
      orderBy: { path: "asc" },
    })
  );

  return rows.map((row) => ({
    path: row.path,
    previousPath: row.previousPath,
    status: mapFileStatus(row.status),
    additions: row.additions ?? 0,
    deletions: row.deletions ?? 0,
    patch: row.patch,
  }));
}

type PrismaReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED";

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
  | { synced: true; error: null; scope: BranchViewSyncScope }
  | {
      synced: false;
      error: string;
      code: BranchViewSyncErrorCode;
      httpStatus: number;
      details?: JsonObject;
      scope: BranchViewSyncScope;
    }
  | {
      synced: false;
      error: null;
      retryAfterSeconds: number;
      throttleReason: BranchViewSyncThrottleReason;
      scope: BranchViewSyncScope;
    };

type BranchViewSyncFailure = Extract<SyncResult, { error: string }>;
type BranchViewProviderThrottle = {
  retryAfterSeconds: number;
};

function providerThrottleFromRetry(
  retryAfterSeconds: number | null | undefined
): BranchViewProviderThrottle {
  return {
    retryAfterSeconds:
      retryAfterSeconds ?? BRANCH_VIEW_PROVIDER_RETRY_FALLBACK_SECONDS,
  };
}

function toProviderThrottleResult(
  scope: BranchViewSyncScope,
  throttle: BranchViewProviderThrottle
): SyncResult {
  return {
    synced: false,
    error: null,
    retryAfterSeconds: throttle.retryAfterSeconds,
    throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
    scope,
  };
}

function maxProviderThrottle(
  throttles: BranchViewProviderThrottle[]
): BranchViewProviderThrottle | null {
  if (throttles.length === 0) {
    return null;
  }
  return {
    retryAfterSeconds: Math.max(
      ...throttles.map((throttle) => throttle.retryAfterSeconds)
    ),
  };
}

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
 * into unified GitHub comment projections plus existing review aggregate rows.
 * Callable from the sync endpoint.
 */
export async function syncCommentsAndReviews(
  ctx: PrContext
): Promise<SyncResult> {
  const { installationId, owner, repo, pullNumber, gitHubPullRequest } = ctx;

  if (!(gitHubPullRequest && pullNumber && ctx.branch)) {
    return {
      synced: false,
      error: "No current pull request record to sync into",
      code: BranchViewSyncErrorCode.PrSyncFailed,
      httpStatus: 409,
      details: {
        reason: BranchViewSyncFailureReason.MissingCurrentPullRequest,
      },
      scope: BranchViewSyncScope.Comments,
    };
  }
  if (
    ctx.branch.currentPullRequestDetailId &&
    ctx.branch.currentPullRequestDetailId !== gitHubPullRequest.id
  ) {
    log.warn("[branch-view/sync] Refusing stale current PR comment sync", {
      externalLinkId: ctx.externalLink.id,
      branchArtifactId: ctx.branch.artifactId,
      currentPullRequestDetailId: ctx.branch.currentPullRequestDetailId,
      pullRequestDetailId: gitHubPullRequest.id,
    });
    return {
      synced: false,
      error: "Branch current pull request relation is stale",
      code: BranchViewSyncErrorCode.PrSyncFailed,
      httpStatus: 409,
      details: {
        reason: BranchViewSyncFailureReason.StaleCurrentPullRequestRelation,
      },
      scope: BranchViewSyncScope.Comments,
    };
  }

  const [apiInline, apiGeneral, apiRevs] = await Promise.all([
    listPullRequestReviewCommentsWithProviderResult(
      installationId,
      owner,
      repo,
      pullNumber
    ),
    listPullRequestIssueCommentsWithProviderResult(
      installationId,
      owner,
      repo,
      pullNumber
    ),
    listPullRequestReviewsWithProviderResult(
      installationId,
      owner,
      repo,
      pullNumber
    ),
  ]);

  const commentsProviderThrottle = maxProviderThrottle(
    [apiInline, apiGeneral, apiRevs]
      .filter(
        (result) =>
          result.status === GitHubProviderResultStatus.ProviderRateLimit
      )
      .map((result) => providerThrottleFromRetry(result.retryAfterSeconds))
  );
  if (commentsProviderThrottle) {
    return toProviderThrottleResult(
      BranchViewSyncScope.Comments,
      commentsProviderThrottle
    );
  }

  if (
    apiInline.status !== GitHubProviderResultStatus.Success ||
    apiGeneral.status !== GitHubProviderResultStatus.Success ||
    apiRevs.status !== GitHubProviderResultStatus.Success
  ) {
    return {
      synced: false,
      error: "Failed to fetch data from GitHub",
      code: BranchViewSyncErrorCode.PrSyncFailed,
      httpStatus: 502,
      details: { reason: BranchViewSyncFailureReason.GitHubPrSyncUnavailable },
      scope: BranchViewSyncScope.Comments,
    };
  }

  // Clean up each GitHub comment source namespace independently. GitHub issue
  // comments and review-thread comments can share raw ids in fixtures, so a
  // live id from one kind must not mask a stale row from the other kind.
  const liveReviewCommentIds = new Set<string>(
    apiInline.value.map((c) => String(c.id))
  );
  const liveIssueCommentIds = new Set<string>(
    apiGeneral.value.map((c) => String(c.id))
  );

  await withDb.tx(async (tx) => {
    await upsertUnifiedGitHubComments(
      tx,
      ctx,
      apiInline.value,
      apiGeneral.value
    );
    await upsertBackfillReviews(tx, gitHubPullRequest.id, apiRevs.value);
    await recomputeAndUpdateAggregate(tx, gitHubPullRequest.id);

    // Soft-delete stale unified projections no longer present on GitHub,
    // including the "GitHub returned zero comments" case.
    await softDeleteGitHubCommentProjection(tx, {
      organizationId: ctx.externalLink.organizationId,
      branchArtifactId: ctx.branch!.artifactId,
      pullRequestDetailId: gitHubPullRequest.id,
      threadKind: GitHubCommentThreadKind.IssueComment,
      liveGithubCommentIds: liveIssueCommentIds,
      deletedAt: new Date(),
    });
    await softDeleteGitHubCommentProjection(tx, {
      organizationId: ctx.externalLink.organizationId,
      branchArtifactId: ctx.branch!.artifactId,
      pullRequestDetailId: gitHubPullRequest.id,
      threadKind: GitHubCommentThreadKind.ReviewThread,
      liveGithubCommentIds: liveReviewCommentIds,
      deletedAt: new Date(),
    });
  });

  log.info("[branch-view/sync] Completed", {
    externalLinkId: ctx.externalLink.id,
    prNumber: pullNumber,
    inlineComments: apiInline.value.length,
    generalComments: apiGeneral.value.length,
    reviews: apiRevs.value.length,
  });

  return { synced: true, error: null, scope: BranchViewSyncScope.Comments };
}

async function upsertUnifiedGitHubComments(
  tx: TransactionClient,
  ctx: PrContext,
  apiInlineComments: ApiInlineComment[],
  apiGeneralComments: ApiGeneralComment[]
): Promise<void> {
  const branchArtifactId = ctx.branch?.artifactId;
  const pullRequestDetailId = ctx.gitHubPullRequest?.id;
  if (!(branchArtifactId && pullRequestDetailId)) {
    throw new Error("Unified GitHub comment sync requires current branch PR");
  }

  // Authors repeat heavily across a PR's comments, and resolving each one issues
  // several sequential queries. Memoize resolution within this transaction keyed
  // by the normalized provider identity so a given author is resolved once.
  // Ghost authors (no GitHub id/node_id) get a per-comment identity derived from
  // the comment's source, so they are intentionally not cached.
  const authorCache = new Map<string, ResolvedExternalGitHubAuthor>();
  const resolveAuthorCached = async (
    author: ExternalGitHubUser | null,
    source: ExternalGitHubAuthorSource
  ): Promise<ResolvedExternalGitHubAuthor> => {
    const identity = normalizeExternalGitHubAuthor(author, source);
    if (!identity.isGhost) {
      const cached = authorCache.get(identity.providerUserId);
      if (cached) {
        return cached;
      }
    }
    const resolved = await resolveExternalGitHubAuthorInTransaction(tx, {
      organizationId: ctx.externalLink.organizationId,
      author,
      source,
    });
    if (!identity.isGhost) {
      authorCache.set(identity.providerUserId, resolved);
    }
    return resolved;
  };

  for (const comment of apiGeneralComments) {
    const author = await resolveAuthorCached(comment.user, {
      sourceKind: "issue_comment",
      githubObjectId: String(comment.id),
      repositoryId: ctx.repositoryId ?? undefined,
      pullNumber: ctx.pullNumber ?? undefined,
    });
    await upsertGitHubIssueCommentThread(tx, {
      organizationId: ctx.externalLink.organizationId,
      branchArtifactId,
      pullRequestDetailId,
      htmlUrl: comment.html_url,
      legacyState: GitHubLegacyCommentState.PENDING,
      lastSyncedAt: new Date(),
      comment: {
        githubCommentId: comment.id,
        githubHtmlUrl: comment.html_url,
        githubUpdatedAt: new Date(comment.updated_at),
        bodyMarkdown: comment.body,
        createdAt: new Date(comment.created_at),
        author: {
          userId: author.user.id,
          externalAuthorId: author.externalAuthor.id,
        },
      },
    });
  }

  for (const comment of apiInlineComments) {
    const author = await resolveAuthorCached(comment.user, {
      sourceKind: "review_comment",
      githubObjectId: String(comment.id),
      repositoryId: ctx.repositoryId ?? undefined,
      pullNumber: ctx.pullNumber ?? undefined,
    });
    await upsertGitHubReviewCommentThread(tx, {
      organizationId: ctx.externalLink.organizationId,
      branchArtifactId,
      pullRequestDetailId,
      reviewThreadId: comment.review_thread_node_id,
      reviewId: comment.pull_request_review_id
        ? String(comment.pull_request_review_id)
        : null,
      rootCommentId: comment.in_reply_to_id ?? comment.id,
      path: comment.path,
      line: comment.line,
      side: normalizeGitHubDiffSide(comment.side),
      startLine: comment.start_line,
      startSide: normalizeGitHubDiffSide(comment.start_side),
      commitSha: comment.commit_id,
      htmlUrl: comment.html_url,
      legacyState: gitHubLegacyStateFromReviewThreadResolved(
        comment.review_thread_is_resolved
      ),
      resolutionStatus: gitHubThreadStatusFromReviewThreadResolved(
        comment.review_thread_is_resolved
      ),
      lastSyncedAt: new Date(),
      comments: [
        {
          githubCommentId: comment.id,
          githubInReplyToCommentId: comment.in_reply_to_id,
          githubHtmlUrl: comment.html_url,
          githubUpdatedAt: new Date(comment.updated_at),
          bodyMarkdown: comment.body,
          createdAt: new Date(comment.created_at),
          author: {
            userId: author.user.id,
            externalAuthorId: author.externalAuthor.id,
          },
        },
      ],
    });
  }
}

/**
 * Map GitHub's review-thread resolution metadata only when the provider
 * returned an explicit value. Null/undefined means the sync payload lacks the
 * authoritative thread state, so projection upsert must preserve local state.
 */
function gitHubLegacyStateFromReviewThreadResolved(
  isResolved: boolean | null | undefined
): GitHubLegacyCommentState | undefined {
  if (isResolved == null) {
    return undefined;
  }
  return isResolved
    ? GitHubLegacyCommentState.ADDRESSED
    : GitHubLegacyCommentState.PENDING;
}

function gitHubThreadStatusFromReviewThreadResolved(
  isResolved: boolean | null | undefined
): ThreadStatus | undefined {
  if (isResolved == null) {
    return undefined;
  }
  return isResolved ? ThreadStatus.RESOLVED : ThreadStatus.OPEN;
}

/**
 * User-initiated branch-view sync. File-cache refresh is always branch-owned;
 * PR review/comment reconciliation is additive when a current PR exists.
 */
export async function syncBranchViewData(ctx: PrContext): Promise<SyncResult> {
  return await syncBranchViewDataWithRequest(ctx);
}

export type BranchViewSyncPreflightResult =
  | { status: "ready"; ctx: PrContext }
  | { status: "not_found" }
  | {
      status: "failed";
      error: string;
      code: BranchViewSyncErrorCode;
      httpStatus: number;
      reason: BranchViewSyncFailureReason;
    };

/**
 * Resolve the sync context without allowing active-sibling credentials to reach
 * provider-backed writes. Active-sibling contexts are only used to run the
 * GitHub relink helper, then the context must reload as pinned-active.
 */
export async function resolveBranchViewSyncPreflightContext(
  externalLinkId: string,
  organizationId: string
): Promise<BranchViewSyncPreflightResult> {
  const ctx = await resolvePrContext(externalLinkId, organizationId, {
    credentialMode: BranchViewContextCredentialMode.RenderRead,
  });
  if (!ctx) {
    return { status: "not_found" };
  }
  if (ctx.credentialSource === BranchViewContextCredentialSource.PinnedActive) {
    return { status: "ready", ctx };
  }
  if (ctx.branch?.invalidCurrentPullRequestRelation) {
    return {
      status: "failed",
      error: "Branch current pull request relation is stale",
      code: BranchViewSyncErrorCode.CurrentPullRequestStale,
      httpStatus: 409,
      reason: BranchViewSyncFailureReason.StaleCurrentPullRequestRelation,
    };
  }
  if (!ctx.credentialRepositoryId) {
    return branchViewSyncProviderPreflightFailure();
  }

  const relinkResult = await githubService.relinkBranchViewRepositoryCredential(
    {
      organizationId,
      activeRepositoryId: ctx.credentialRepositoryId,
    }
  );
  if (isHardRepositoryRelinkFailure(relinkResult)) {
    return branchViewSyncProviderPreflightFailure();
  }

  const reloaded = await resolvePrContext(ctx.externalLink.id, organizationId);
  if (
    reloaded?.credentialSource ===
    BranchViewContextCredentialSource.PinnedActive
  ) {
    return { status: "ready", ctx: reloaded };
  }
  return branchViewSyncProviderPreflightFailure();
}

function isHardRepositoryRelinkFailure(
  relinkResult: RepositoryArtifactRelinkResult
): boolean {
  // Partial or skipped org-level relinks can still leave this branch repaired;
  // only a pre-transaction guarded-write failure lacks per-branch state to trust.
  const noRelinkWorkObserved =
    relinkResult.activeRepositoryCount === 0 &&
    relinkResult.staleRepositoryCount === 0 &&
    relinkResult.branchRelinkedCount === 0 &&
    relinkResult.pullRequestRelinkedCount === 0 &&
    relinkResult.branchCollisionSkippedCount === 0 &&
    relinkResult.pullRequestCollisionSkippedCount === 0 &&
    relinkResult.ambiguousRepositorySkippedCount === 0 &&
    relinkResult.blockedBranchCount === 0;
  return (
    relinkResult.status === RepositoryArtifactRelinkStatus.Skipped &&
    noRelinkWorkObserved &&
    relinkResult.reasons.includes(
      RepositoryArtifactRelinkReason.GuardedWriteFailed
    )
  );
}

function branchViewSyncProviderPreflightFailure(): Extract<
  BranchViewSyncPreflightResult,
  { status: "failed" }
> {
  return {
    status: "failed",
    error: "Failed to fetch data from GitHub",
    code: BranchViewSyncErrorCode.PrSyncFailed,
    httpStatus: 409,
    reason: BranchViewSyncFailureReason.GitHubPrSyncUnavailable,
  };
}

/**
 * Sync Branch View provider projections for the requested scope. Branch scope
 * refreshes branch-owned lifecycle, checks, and file-cache state only; comments
 * scope refreshes PR comments/reviews without claiming branch freshness.
 */
export async function syncBranchViewDataWithRequest(
  ctx: PrContext,
  request: BranchViewSyncRequest = { scope: BranchViewSyncScope.Branch }
): Promise<SyncResult> {
  const scope = request.scope ?? BranchViewSyncScope.Branch;
  if (scope === BranchViewSyncScope.Comments) {
    return syncCommentsAndReviews(ctx);
  }

  if (!ctx.branch) {
    return {
      synced: false,
      error: "No branch record to sync",
      code: BranchViewSyncErrorCode.FileCacheRefreshFailed,
      httpStatus: 500,
      details: { reason: BranchViewSyncFailureReason.FileCacheRefreshFailed },
      scope: BranchViewSyncScope.Branch,
    };
  }
  if (ctx.branch.invalidCurrentPullRequestRelation) {
    log.warn("[branch-view/sync] Refusing stale current PR relation", {
      externalLinkId: ctx.externalLink.id,
      branchArtifactId: ctx.branch.artifactId,
      currentPullRequestDetailId: ctx.branch.currentPullRequestDetailId,
    });
    return {
      synced: false,
      error: "Branch current pull request relation is stale",
      code: BranchViewSyncErrorCode.CurrentPullRequestStale,
      httpStatus: 409,
      details: {
        reason: BranchViewSyncFailureReason.StaleCurrentPullRequestRelation,
      },
      scope: BranchViewSyncScope.Branch,
    };
  }

  const startedAt = new Date();
  const syncStart = await startBranchSync({
    organizationId: ctx.externalLink.organizationId,
    branchArtifactId: ctx.branch.artifactId,
    headSha: ctx.branch.headSha ?? ctx.gitHubPullRequest?.headSha ?? null,
    currentFileCacheHeadSha: ctx.branch.fileCacheHeadSha,
    currentLastSyncStartedAt: ctx.branch.lastSyncStartedAt,
    currentLastSyncCompletedAt: ctx.branch.lastSyncCompletedAt,
    currentLastSyncErrorCode: ctx.branch.lastSyncErrorCode,
    currentSyncStatus: parseBranchSyncStatus(ctx.branch.syncStatus),
    startedAt,
  });
  if (syncStart?.throttled) {
    return {
      synced: false,
      error: null,
      retryAfterSeconds: syncStart.retryAfterSeconds,
      throttleReason: syncStart.throttleReason,
      scope: BranchViewSyncScope.Branch,
    };
  }

  const providerThrottles: BranchViewProviderThrottle[] = [];
  const lifecycleResult = await refreshPullRequestLifecycle({
    organizationId: ctx.externalLink.organizationId,
    installationId: ctx.installationId,
    owner: ctx.owner,
    repo: ctx.repo,
    pullNumber: ctx.pullNumber,
    branchArtifactId: ctx.branch.artifactId,
    pullRequestDetailId: ctx.gitHubPullRequest?.id ?? null,
    repositoryId:
      ctx.gitHubPullRequest?.repositoryId ?? ctx.repositoryId ?? null,
    requireCurrentRelation: Boolean(ctx.gitHubPullRequest),
  });
  if (lifecycleResult.status === GitHubProviderResultStatus.ProviderRateLimit) {
    providerThrottles.push(
      providerThrottleFromRetry(lifecycleResult.retryAfterSeconds)
    );
  }

  const lifecycleFailure = toLifecycleSyncFailure(lifecycleResult);
  if (!lifecycleFailure) {
    const checksThrottle = await refreshBranchChecksStatus(
      ctx,
      lifecycleResult.status === "refreshed" ? lifecycleResult.headSha : null
    );
    if (checksThrottle) {
      providerThrottles.push(checksThrottle);
    }
  }

  const fileCacheResult = await refreshBranchFileChangeCache(
    ctx.branch.artifactId,
    {
      organizationId: ctx.externalLink.organizationId,
      syncAlreadyStarted: true,
    }
  );
  if (
    fileCacheResult.ok &&
    fileCacheResult.value.throttled &&
    fileCacheResult.value.throttleReason ===
      BranchViewSyncThrottleReason.ProviderRateLimit
  ) {
    providerThrottles.push({
      retryAfterSeconds: fileCacheResult.value.retryAfterSeconds,
    });
  }

  const providerThrottle = maxProviderThrottle(providerThrottles);
  if (providerThrottle) {
    await markBranchSyncProviderRateLimited({
      organizationId: ctx.externalLink.organizationId,
      branchArtifactId: ctx.branch.artifactId,
      completedAt: new Date(),
      startedAt,
    });
    return toProviderThrottleResult(
      BranchViewSyncScope.Branch,
      providerThrottle
    );
  }

  if (!fileCacheResult.ok) {
    return handleFileCacheFailure({
      ctx,
      error: fileCacheResult.error,
      lifecycleFailure,
      startedAt,
    });
  }

  if (lifecycleFailure) {
    await persistLifecycleFailure(ctx, lifecycleFailure, startedAt);
    return lifecycleFailure;
  }

  await markBranchSyncCompleted({
    organizationId: ctx.externalLink.organizationId,
    branchArtifactId: ctx.branch.artifactId,
    completedAt: new Date(),
    startedAt,
  });
  return { synced: true, error: null, scope: BranchViewSyncScope.Branch };
}

async function refreshBranchChecksStatus(
  ctx: PrContext,
  headShaOverride: string | null = null
): Promise<BranchViewProviderThrottle | null> {
  const branch = ctx.branch;
  const headSha = headShaOverride ?? branch?.headSha;
  if (!(branch && headSha)) {
    return null;
  }

  const rollupResult = await queryStatusCheckRollupWithProviderResult(
    ctx.installationId,
    ctx.owner,
    ctx.repo,
    headSha
  );
  if (rollupResult.status === GitHubProviderResultStatus.ProviderRateLimit) {
    return providerThrottleFromRetry(rollupResult.retryAfterSeconds);
  }
  if (rollupResult.status !== GitHubProviderResultStatus.Success) {
    return null;
  }

  const persistResult = await withDb.tx((tx) =>
    persistBranchStatusChecksFromRollup(tx, {
      branchArtifactId: branch.artifactId,
      organizationId: ctx.externalLink.organizationId,
      headSha,
      rollup: rollupResult.value,
    })
  );
  if (persistResult.status === "skipped") {
    log.warn("[branch-view/sync] Skipped stale checksStatus update", {
      externalLinkId: ctx.externalLink.id,
      branchArtifactId: branch.artifactId,
      headSha,
      reason: persistResult.reason,
    });
  }
  return null;
}

function toLifecycleSyncFailure(
  result: PrLifecycleRefreshResult
): BranchViewSyncFailure | null {
  if (
    result.status !== GitHubProviderResultStatus.ProviderUnavailable &&
    result.status !== "guarded_write_failed"
  ) {
    return null;
  }
  return {
    synced: false,
    error: result.message,
    code: result.code,
    httpStatus: result.httpStatus,
    details: result.details,
    scope: BranchViewSyncScope.Branch,
  };
}

async function handleFileCacheFailure({
  ctx,
  error,
  lifecycleFailure,
  startedAt,
}: {
  ctx: PrContext;
  error: unknown;
  lifecycleFailure: BranchViewSyncFailure | null;
  startedAt: Date;
}): Promise<BranchViewSyncFailure | SyncResult> {
  if (lifecycleFailure) {
    await persistLifecycleFailure(ctx, lifecycleFailure, startedAt);
    log.warn("[branch-view/sync] File cache and lifecycle failed", {
      externalLinkId: ctx.externalLink.id,
      branchArtifactId: ctx.branch?.artifactId,
      status: error,
      lifecycleCode: lifecycleFailure.code,
    });
    return lifecycleFailure;
  }
  await markBranchSyncFailed({
    organizationId: ctx.externalLink.organizationId,
    branchArtifactId: ctx.branch!.artifactId,
    code: BranchViewSyncErrorCode.FileCacheRefreshFailed,
    message: "Failed to refresh branch file cache",
    completedAt: new Date(),
    startedAt,
  });
  return {
    synced: false,
    error: "Failed to refresh branch file cache",
    code: BranchViewSyncErrorCode.FileCacheRefreshFailed,
    httpStatus: 500,
    details: { reason: BranchViewSyncFailureReason.FileCacheRefreshFailed },
    scope: BranchViewSyncScope.Branch,
  };
}

async function persistLifecycleFailure(
  ctx: PrContext,
  failure: BranchViewSyncFailure,
  startedAt: Date
): Promise<void> {
  if (!ctx.branch) {
    return;
  }
  await markBranchSyncFailed({
    organizationId: ctx.externalLink.organizationId,
    branchArtifactId: ctx.branch.artifactId,
    code: failure.code,
    message: failure.error,
    completedAt: new Date(),
    startedAt,
  });
}

// --- Context resolvers ---

type FeatureContext = {
  slug: string;
  title: string;
  projectId: string | null;
  teamId: string | null;
  teamName: string | null;
  projectName: string | null;
};

type ProjectRecoveryContext = Pick<
  FeatureContext,
  "projectId" | "projectName" | "teamId" | "teamName"
>;

async function resolveProjectRecoveryContext(
  ctx: PrContext,
  projectId: string | null | undefined
): Promise<ProjectRecoveryContext | null> {
  if (!projectId) {
    return null;
  }
  const project = await withDb((db) =>
    db.project.findFirst({
      where: {
        id: projectId,
        organizationId: ctx.externalLink.organizationId,
      },
      select: {
        id: true,
        name: true,
        teams: {
          where: {
            project: { organizationId: ctx.externalLink.organizationId },
            team: { organizationId: ctx.externalLink.organizationId },
          },
          select: { team: { select: { id: true, name: true } } },
          take: 1,
        },
      },
    })
  );
  if (!project) {
    return null;
  }
  const firstTeam = project.teams?.[0]?.team ?? null;
  return {
    projectId: project.id,
    projectName: project.name,
    teamId: firstTeam?.id ?? null,
    teamName: firstTeam?.name ?? null,
  };
}

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
          organizationId: ctx.externalLink.organizationId,
          targetId: ctx.externalLink.id,
          linkType: LinkType.Produces,
          source: {
            organizationId: ctx.externalLink.organizationId,
            type: ArtifactType.DOCUMENT,
          },
        },
        select: { sourceId: true },
      })
    );
    resolvedArtifactId = linkToArtifact?.sourceId ?? null;
  }

  if (!resolvedArtifactId) {
    const projectContext = await resolveProjectRecoveryContext(
      ctx,
      ctx.externalLink.projectId
    );
    return projectContext
      ? {
          slug: "",
          title: "",
          ...projectContext,
        }
      : null;
  }

  // Go one more level up the source chain to find a feature.
  const featureLink = await withDb((db) =>
    db.artifactLink.findFirst({
      where: {
        organizationId: ctx.externalLink.organizationId,
        targetId: resolvedArtifactId,
        linkType: LinkType.Produces,
        source: {
          organizationId: ctx.externalLink.organizationId,
          type: ArtifactType.DOCUMENT,
        },
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
        organizationId: ctx.externalLink.organizationId,
        type: ArtifactType.DOCUMENT,
      },
      select: {
        slug: true,
        name: true,
        subtype: true,
        projectId: true,
        project: {
          select: {
            name: true,
            teams: {
              where: {
                project: { organizationId: ctx.externalLink.organizationId },
                team: { organizationId: ctx.externalLink.organizationId },
              },
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
    const projectContext = await resolveProjectRecoveryContext(
      ctx,
      ctx.externalLink.projectId
    );
    return projectContext
      ? {
          slug: "",
          title: "",
          ...projectContext,
        }
      : null;
  }

  const firstTeam = feature.project?.teams?.[0]?.team ?? null;

  return {
    slug: feature.slug ?? "",
    title: feature.name,
    projectId: feature.projectId,
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
      where: {
        id: artifactId,
        organizationId: ctx.externalLink.organizationId,
        type: ArtifactType.DOCUMENT,
      },
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
        organizationId: ctx.externalLink.organizationId,
        targetId: artifactId,
        linkType: LinkType.Produces,
        source: {
          organizationId: ctx.externalLink.organizationId,
          type: ArtifactType.DOCUMENT,
        },
      },
      select: { sourceId: true },
    })
  );

  if (!planLink) {
    return null;
  }

  const plan = await withDb((db) =>
    db.artifact.findFirst({
      where: {
        id: planLink.sourceId,
        organizationId: ctx.externalLink.organizationId,
        type: ArtifactType.DOCUMENT,
      },
      select: { slug: true, name: true, subtype: true },
    })
  );

  if (plan?.subtype === ArtifactSubtype.IMPLEMENTATION_PLAN) {
    return { slug: plan.slug ?? "", title: plan.name };
  }

  return null;
}
