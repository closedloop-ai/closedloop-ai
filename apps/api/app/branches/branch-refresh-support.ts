import {
  type BranchPageDetail,
  BranchRefreshReason,
  type BranchRefreshResponse,
  BranchRefreshStatus,
  type BranchTagPermissions,
} from "@repo/api/src/types/branch";
import { GitHubFetchTrigger } from "@repo/api/src/types/github-read-model";
import {
  GitHubInstallationStatus,
  type PrismaClient,
  withDb,
} from "@repo/database";
import {
  GitHubServerSyncReason,
  GitHubServerSyncStatus,
  githubServerSyncService,
} from "@/app/integrations/github/sync-service";
import { getPrismaErrorCode } from "@/lib/db-utils";
import {
  type RecordWriteInTransaction,
  writeInShape,
} from "@/lib/record-write-in-transaction";
import { finalizeCloudBranchProductResponse } from "./branch-product-response-eligibility";
import { projectCloudBranchRefreshDetail } from "./branch-read-service/canonical-projection";
import type {
  BranchArtifactRow,
  BranchDetailArtifactRow,
} from "./branch-read-service/persisted-row-read";

const BRANCH_REFRESH_WINDOW_MS = 30_000;
const BRANCH_REFRESH_ORG_BUCKET_LIMIT = 20;
const BRANCH_REFRESH_ACTOR_BUCKET_LIMIT = 5;
const BRANCH_REFRESH_BUCKET_PREFIX = "branch_refresh";

export type RefreshActor = {
  userId: string;
  authMethod: string;
  tagPermissions?: BranchTagPermissions;
};

export type GetBranchDetail = (
  organizationId: string,
  branchId: string,
  tagPermissions?: BranchTagPermissions
) => Promise<BranchPageDetail | null>;

export async function finalizeBranchRefreshResponse(
  organizationId: string,
  branchId: string,
  response: BranchRefreshResponse
): Promise<BranchRefreshResponse> {
  const branch = await finalizeCloudBranchProductResponse(
    organizationId,
    branchId,
    response.branch
  );
  return { ...response, branch };
}

export async function refreshTombstonedBranchPullRequest(
  organizationId: string,
  branchId: string,
  actor: RefreshActor,
  target: BranchDetailArtifactRow,
  getBranchDetail: GetBranchDetail
): Promise<BranchRefreshResponse> {
  const syncResult =
    await githubServerSyncService.refreshTombstonedBranchPullRequest({
      actorUserId: actor.userId,
      branchArtifactId: branchId,
      organizationId,
      trigger: toGitHubFetchTrigger(actor.authMethod),
    });
  if (syncResult.status === GitHubServerSyncStatus.Refreshed) {
    return {
      branch: await getBranchDetail(
        organizationId,
        branchId,
        actor.tagPermissions
      ),
      status: BranchRefreshStatus.Refreshed,
    };
  }
  if (syncResult.status === GitHubServerSyncStatus.Retryable) {
    return {
      branch: projectCloudBranchRefreshDetail(
        target,
        organizationId,
        actor.tagPermissions
      ),
      status: BranchRefreshStatus.Retryable,
      reason: toBranchRefreshReason(syncResult.reason),
      ...(syncResult.retryAfterSeconds
        ? { retryAfterSeconds: syncResult.retryAfterSeconds }
        : {}),
    };
  }
  return {
    branch: projectCloudBranchRefreshDetail(
      target,
      organizationId,
      actor.tagPermissions
    ),
    status:
      syncResult.status === GitHubServerSyncStatus.NotApplicable
        ? BranchRefreshStatus.NotApplicable
        : BranchRefreshStatus.Failed,
    reason: toBranchRefreshReason(syncResult.reason),
  };
}

/**
 * Consume one refresh from the caller's bucket and then the organization's.
 * Unrecorded, each bucket is its own transaction with its own P2002 retry, as
 * on main, so an organization refusal keeps the caller's spend. Recorded, both
 * share ONE transaction and `recordConsumed` runs on it only when both buckets
 * admitted the refresh, so a receipt that cannot be stored gives the budget
 * back (ISS-12552).
 */
export function consumeRefreshBudget(
  organizationId: string,
  actor: RefreshActor,
  now: Date,
  recordConsumed?: RecordRefreshBudgetConsumed
): Promise<RefreshBudgetDecision> {
  return writeInShape(recordConsumed, {
    unrecorded: () =>
      consumeRefreshBudgetUnrecorded(organizationId, actor, now),
    recorded: (record) =>
      consumeRefreshBudgetRecorded(organizationId, actor, now, record),
  });
}

/** Main's shape: the caller's bucket, then the organization's, apart. */
async function consumeRefreshBudgetUnrecorded(
  organizationId: string,
  actor: RefreshActor,
  now: Date
): Promise<RefreshBudgetDecision> {
  const actorBudget = await consumeBucket(
    `${BRANCH_REFRESH_BUCKET_PREFIX}:actor`,
    `${organizationId}:${actor.authMethod}:${actor.userId}`,
    BRANCH_REFRESH_ACTOR_BUCKET_LIMIT,
    now
  );
  if (!actorBudget.ok) {
    return actorBudget;
  }
  return consumeBucket(
    `${BRANCH_REFRESH_BUCKET_PREFIX}:org`,
    organizationId,
    BRANCH_REFRESH_ORG_BUCKET_LIMIT,
    now
  );
}

async function consumeRefreshBudgetRecorded(
  organizationId: string,
  actor: RefreshActor,
  now: Date,
  recordConsumed: RecordRefreshBudgetConsumed
): Promise<RefreshBudgetDecision> {
  const consume = () =>
    withDb.tx(async (tx) => {
      const actorBudget = await consumeBucketInTransaction(
        tx,
        `${BRANCH_REFRESH_BUCKET_PREFIX}:actor`,
        `${organizationId}:${actor.authMethod}:${actor.userId}`,
        BRANCH_REFRESH_ACTOR_BUCKET_LIMIT,
        now
      );
      if (!actorBudget.ok) {
        return actorBudget;
      }
      const orgBudget = await consumeBucketInTransaction(
        tx,
        `${BRANCH_REFRESH_BUCKET_PREFIX}:org`,
        organizationId,
        BRANCH_REFRESH_ORG_BUCKET_LIMIT,
        now
      );
      if (orgBudget.ok) {
        await recordConsumed(tx, undefined);
      }
      return orgBudget;
    });
  try {
    return await consume();
  } catch (error) {
    // A concurrent first consumer created a bucket row between the read and
    // the insert. The failed transaction rolled back whole, so both buckets
    // are retried on a fresh one.
    if (getPrismaErrorCode(error) !== "P2002") {
      throw error;
    }
    return consume();
  }
}

export async function claimPullRequestRefresh(
  organizationId: string,
  target: BranchArtifactRow,
  pullRequestDetailId: string,
  now: Date
): Promise<boolean> {
  const repositoryId = target.branch.repositoryId;
  if (!repositoryId) {
    return false;
  }
  const staleBefore = new Date(now.getTime() - BRANCH_REFRESH_WINDOW_MS);
  const result = await withDb((db) =>
    db.pullRequestDetail.updateMany({
      where: {
        id: pullRequestDetailId,
        branchArtifactId: target.id,
        repositoryId,
        branchArtifact: { organizationId },
        repository: {
          removedAt: null,
          installation: {
            organizationId,
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
        currentForBranches: {
          some: {
            artifactId: target.id,
            currentPullRequestDetailId: pullRequestDetailId,
            artifact: { organizationId },
            repository: {
              removedAt: null,
              installation: {
                organizationId,
                status: GitHubInstallationStatus.ACTIVE,
              },
            },
          },
        },
        OR: [
          { lastRefreshAttemptAt: null },
          { lastRefreshAttemptAt: { lt: staleBefore } },
        ],
      },
      data: { lastRefreshAttemptAt: now },
    })
  );
  return result.count === 1;
}

export function hasActiveRepository(
  row: BranchArtifactRow
): row is BranchArtifactRow & {
  branch: BranchArtifactRow["branch"] & {
    repository: NonNullable<BranchArtifactRow["branch"]["repository"]>;
  };
} {
  const repository = row.branch.repository;
  return (
    repository !== null &&
    repository.removedAt === null &&
    repository.installation.status === GitHubInstallationStatus.ACTIVE
  );
}

export const BRANCH_REFRESH_RETRY_AFTER_SECONDS = Math.ceil(
  BRANCH_REFRESH_WINDOW_MS / 1000
);

function toBranchRefreshReason(
  reason: GitHubServerSyncReason
): BranchRefreshReason {
  switch (reason) {
    case GitHubServerSyncReason.AlreadyRefreshing:
      return BranchRefreshReason.AlreadyRefreshing;
    case GitHubServerSyncReason.GuardedWriteFailed:
      return BranchRefreshReason.GuardedWriteFailed;
    case GitHubServerSyncReason.NoCurrentPullRequest:
      return BranchRefreshReason.NoCurrentPullRequest;
    case GitHubServerSyncReason.NoCredential:
      return BranchRefreshReason.GitHubIdentityRequired;
    case GitHubServerSyncReason.CredentialExpired:
    case GitHubServerSyncReason.CredentialRevoked:
    case GitHubServerSyncReason.CredentialDecryptionFailed:
      return BranchRefreshReason.GitHubIdentityExpired;
    case GitHubServerSyncReason.CredentialInsufficientScope:
      return BranchRefreshReason.GitHubIdentityInsufficientScope;
    case GitHubServerSyncReason.ProviderRateLimited:
      return BranchRefreshReason.ProviderRateLimited;
    case GitHubServerSyncReason.ProviderUnavailable:
      return BranchRefreshReason.ProviderUnavailable;
    case GitHubServerSyncReason.CrossUserDenied:
    case GitHubServerSyncReason.InvalidRepositoryFullName:
    case GitHubServerSyncReason.NoActiveRepository:
    case GitHubServerSyncReason.NoEligibleSessionReference:
    case GitHubServerSyncReason.NoTombstonedRepository:
    case GitHubServerSyncReason.Unsupported:
    case GitHubServerSyncReason.Unknown:
      return BranchRefreshReason.NotFound;
    case GitHubServerSyncReason.Success:
      return BranchRefreshReason.ProviderUnavailable;
    default:
      return BranchRefreshReason.ProviderUnavailable;
  }
}

function toGitHubFetchTrigger(authMethod: string): GitHubFetchTrigger {
  return authMethod === "session"
    ? GitHubFetchTrigger.UserAction
    : GitHubFetchTrigger.Unknown;
}

async function consumeBucket(
  bucket: string,
  subject: string,
  maxRequests: number,
  now: Date
): Promise<RefreshBudgetDecision> {
  try {
    return await withDb.tx((db) =>
      consumeBucketInTransaction(db, bucket, subject, maxRequests, now)
    );
  } catch (error) {
    if (getPrismaErrorCode(error) !== "P2002") {
      throw error;
    }
    return withDb.tx((db) =>
      consumeBucketInTransaction(db, bucket, subject, maxRequests, now)
    );
  }
}

async function consumeBucketInTransaction(
  db: Pick<PrismaClient, "oAuthRateLimit">,
  bucket: string,
  subject: string,
  maxRequests: number,
  now: Date
): Promise<RefreshBudgetDecision> {
  const windowExpiresAt = new Date(now.getTime() + BRANCH_REFRESH_WINDOW_MS);
  const existing = await db.oAuthRateLimit.findUnique({
    where: { bucket_subject: { bucket, subject } },
    // The row is only ever a window decision plus the id every branch below
    // re-asserts in its conditional update; `requestCount` is deliberately NOT
    // read, because this path compares it inside the `updateMany` predicate
    // rather than against a snapshot that a concurrent consumer could stale.
    select: { id: true, windowExpiresAt: true },
  });
  if (!existing) {
    await db.oAuthRateLimit.create({
      data: {
        bucket,
        subject,
        requestCount: 1,
        windowStartedAt: now,
        windowExpiresAt,
      },
      select: { id: true },
    });
    return { ok: true };
  }
  if (existing.windowExpiresAt <= now) {
    const reset = await db.oAuthRateLimit.updateMany({
      where: { id: existing.id, windowExpiresAt: { lte: now } },
      data: { requestCount: 1, windowStartedAt: now, windowExpiresAt },
    });
    if (reset.count === 1) {
      return { ok: true };
    }
  }
  const consumed = await db.oAuthRateLimit.updateMany({
    where: {
      id: existing.id,
      requestCount: { lt: maxRequests },
      windowExpiresAt: { gt: now },
    },
    data: { requestCount: { increment: 1 } },
  });
  if (consumed.count === 1) {
    return { ok: true };
  }
  return {
    ok: false,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((existing.windowExpiresAt.getTime() - now.getTime()) / 1000)
    ),
  };
}

type RefreshBudgetDecision =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

/** A caller's record of an admitted refresh, run on the budget's transaction. */
export type RecordRefreshBudgetConsumed = RecordWriteInTransaction<void>;
