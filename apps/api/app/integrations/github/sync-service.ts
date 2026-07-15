import { LinkType } from "@repo/api/src/types/artifact";
import {
  GitHubFetchTrigger,
  type GitHubFetchTrigger as GitHubFetchTriggerValue,
  GitHubSyncResultReason,
  type GitHubSyncResultReason as GitHubSyncResultReasonValue,
} from "@repo/api/src/types/github-read-model";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactType,
  GitHubInstallationStatus,
  type Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import {
  GitHubProviderResultStatus,
  type GitHubSinglePullRequestResult,
  GitHubUserTokenProviderResultStatus,
  getSinglePullRequestWithUserTokenProviderResult,
} from "@repo/github";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { pullRequestLocData } from "@/app/branches/pull-request-loc-data";
import {
  gitHubFetchProvenanceData,
  userOAuthRestFetchProvenance,
} from "@/lib/github-fetch-provenance";
import { decryptIntegrationToken } from "@/lib/integration-encryption";

export type RefreshTombstonedBranchPullRequestInput = {
  actorUserId: string;
  branchArtifactId: string;
  organizationId: string;
  now?: Date;
  trigger?: GitHubFetchTriggerValue;
};

export const GitHubServerSyncStatus = {
  Refreshed: "refreshed",
  Retryable: "retryable",
  Failed: "failed",
  NotApplicable: "not_applicable",
} as const;
export type GitHubServerSyncStatus =
  (typeof GitHubServerSyncStatus)[keyof typeof GitHubServerSyncStatus];

export const GitHubServerSyncReason = {
  ...GitHubSyncResultReason,
  AlreadyRefreshing: "already_refreshing",
  GuardedWriteFailed: "guarded_write_failed",
  InvalidRepositoryFullName: "invalid_repository_full_name",
  NoCurrentPullRequest: "no_current_pull_request",
  NoTombstonedRepository: "no_tombstoned_repository",
  ProviderRateLimited: "provider_rate_limited",
} as const;
export type GitHubServerSyncReason =
  (typeof GitHubServerSyncReason)[keyof typeof GitHubServerSyncReason];

export type GitHubServerSyncResult =
  | {
      status: typeof GitHubServerSyncStatus.Refreshed;
      reason: typeof GitHubSyncResultReason.Success;
    }
  | {
      status: typeof GitHubServerSyncStatus.Retryable;
      reason:
        | typeof GitHubServerSyncReason.AlreadyRefreshing
        | typeof GitHubServerSyncReason.ProviderRateLimited
        | typeof GitHubServerSyncReason.ProviderUnavailable;
      retryAfterSeconds?: number;
    }
  | {
      status: typeof GitHubServerSyncStatus.NotApplicable;
      reason:
        | typeof GitHubServerSyncReason.NoCurrentPullRequest
        | typeof GitHubServerSyncReason.NoTombstonedRepository;
    }
  | {
      status: typeof GitHubServerSyncStatus.Failed;
      reason:
        | typeof GitHubServerSyncReason.GuardedWriteFailed
        | typeof GitHubServerSyncReason.InvalidRepositoryFullName
        | typeof GitHubSyncResultReason.NoActiveRepository
        | typeof GitHubSyncResultReason.NoCredential
        | typeof GitHubSyncResultReason.CredentialRevoked
        | typeof GitHubSyncResultReason.CredentialExpired
        | typeof GitHubSyncResultReason.CredentialDecryptionFailed
        | typeof GitHubSyncResultReason.CredentialInsufficientScope
        | typeof GitHubSyncResultReason.CrossUserDenied
        | typeof GitHubSyncResultReason.NoEligibleSessionReference
        | typeof GitHubSyncResultReason.Unsupported;
    };

type GitHubServerSyncClient = Pick<
  TransactionClient,
  | "artifact"
  | "artifactLink"
  | "branchDetail"
  | "gitHubUserConnection"
  | "pullRequestDetail"
>;

type BranchSyncTargetRecord = NonNullable<
  Awaited<ReturnType<typeof findBranchSyncTarget>>
>;
type BranchSyncTarget = BranchSyncTargetRecord & {
  branch: NonNullable<BranchSyncTargetRecord["branch"]>;
};
// Narrowed target for tombstoned App repos, whose installation-repo relation is
// present. Non-App branches (PRD-510 D2/FR8) have a null `repository`.
type BranchSyncTargetWithRepository = BranchSyncTarget & {
  branch: BranchSyncTarget["branch"] & {
    repository: NonNullable<BranchSyncTarget["branch"]["repository"]>;
  };
};

type GitHubUserSyncCredential =
  | {
      ok: true;
      token: string;
    }
  | {
      ok: false;
      reason:
        | typeof GitHubSyncResultReason.NoCredential
        | typeof GitHubSyncResultReason.CredentialRevoked
        | typeof GitHubSyncResultReason.CredentialExpired
        | typeof GitHubSyncResultReason.CredentialDecryptionFailed
        | typeof GitHubSyncResultReason.CredentialInsufficientScope;
    };

const SESSION_PR_LINK_METADATA_SCHEMA = z
  .object({
    linkKind: z.literal(SessionArtifactLinkKind.SessionPr).optional(),
    repositoryFullName: z.string().min(1),
    prNumber: z.number().int().positive(),
  })
  .passthrough();
const REFRESH_WINDOW_MS = 30_000;

/**
 * Server-side GitHub sync entrypoints. App-covered repositories deliberately
 * stay on the App-token path owned by existing services; this service only
 * performs user-token reads for tombstoned repositories when the requesting
 * user owns a synced session PR reference to the target branch/PR.
 */
export const githubServerSyncService = {
  async refreshTombstonedBranchPullRequest(
    input: RefreshTombstonedBranchPullRequestInput
  ): Promise<GitHubServerSyncResult> {
    const now = input.now ?? new Date();
    return await withDb(async (db) =>
      refreshTombstonedBranchPullRequestWithClient(db, input, now)
    );
  },
};

async function refreshTombstonedBranchPullRequestWithClient(
  db: GitHubServerSyncClient,
  input: RefreshTombstonedBranchPullRequestInput,
  now: Date
): Promise<GitHubServerSyncResult> {
  const target = await findBranchSyncTarget(
    db,
    input.organizationId,
    input.branchArtifactId
  );
  if (!hasBranchDetail(target)) {
    return failed(GitHubSyncResultReason.NoActiveRepository);
  }

  if (hasActiveRepository(target)) {
    return notApplicable(GitHubServerSyncReason.NoTombstonedRepository);
  }
  if (!isTombstonedRepository(target)) {
    return failed(GitHubSyncResultReason.NoActiveRepository);
  }

  const currentPullRequest = target.branch.currentPullRequestDetail;
  if (!currentPullRequest) {
    return notApplicable(GitHubServerSyncReason.NoCurrentPullRequest);
  }

  const repositoryIdentity = parseRepositoryFullName(
    target.branch.repository.fullName
  );
  if (!repositoryIdentity) {
    await stampTombstonedRefreshFailure(
      db,
      input,
      target,
      GitHubSyncResultReason.Unsupported,
      now
    );
    return failed(GitHubServerSyncReason.InvalidRepositoryFullName);
  }

  const eligible = await hasOwnedSessionPullRequestReference(db, {
    actorUserId: input.actorUserId,
    branchArtifactId: input.branchArtifactId,
    organizationId: input.organizationId,
    pullNumber: currentPullRequest.number,
    repositoryFullName: target.branch.repository.fullName,
  });
  if (!eligible) {
    await stampTombstonedRefreshFailure(
      db,
      input,
      target,
      GitHubSyncResultReason.NoEligibleSessionReference,
      now
    );
    return failed(GitHubSyncResultReason.NoEligibleSessionReference);
  }

  const credential = await resolveUserSyncCredential(db, {
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    repositoryPrivate: target.branch.repository.private,
    now,
  });
  if (!credential.ok) {
    await stampTombstonedRefreshFailure(
      db,
      input,
      target,
      credential.reason,
      now,
      { recordRefreshAttempt: false }
    );
    return failed(credential.reason);
  }

  const claimed = await claimTombstonedPullRequestRefresh(
    db,
    input.organizationId,
    target,
    now
  );
  if (!claimed) {
    return retryable(GitHubServerSyncReason.AlreadyRefreshing);
  }

  const providerResult = await getSinglePullRequestWithUserTokenProviderResult(
    credential.token,
    repositoryIdentity.owner,
    repositoryIdentity.name,
    currentPullRequest.number
  );
  if (providerResult.status === GitHubProviderResultStatus.ProviderRateLimit) {
    await stampTombstonedRefreshFailure(
      db,
      input,
      target,
      GitHubSyncResultReason.ProviderUnavailable,
      now
    );
    return retryable(
      GitHubServerSyncReason.ProviderRateLimited,
      providerResult.retryAfterSeconds ?? undefined
    );
  }
  if (
    providerResult.status ===
    GitHubUserTokenProviderResultStatus.CredentialUnauthorized
  ) {
    await stampTombstonedRefreshFailure(
      db,
      input,
      target,
      GitHubSyncResultReason.CredentialRevoked,
      now
    );
    return failed(GitHubSyncResultReason.CredentialRevoked);
  }
  if (
    providerResult.status ===
    GitHubUserTokenProviderResultStatus.CredentialInsufficientScope
  ) {
    await stampTombstonedRefreshFailure(
      db,
      input,
      target,
      GitHubSyncResultReason.CredentialInsufficientScope,
      now
    );
    return failed(GitHubSyncResultReason.CredentialInsufficientScope);
  }
  if (providerResult.status !== GitHubProviderResultStatus.Success) {
    await stampTombstonedRefreshFailure(
      db,
      input,
      target,
      GitHubSyncResultReason.ProviderUnavailable,
      now
    );
    log.warn("[github/sync] Tombstoned PR refresh failed", {
      reason: GitHubSyncResultReason.ProviderUnavailable,
      providerStatus: providerResult.status,
      branchArtifactId: input.branchArtifactId,
      organizationId: input.organizationId,
    });
    return retryable(GitHubServerSyncReason.ProviderUnavailable);
  }
  if (providerResult.value.githubId !== currentPullRequest.githubId) {
    await stampTombstonedRefreshFailure(
      db,
      input,
      target,
      GitHubSyncResultReason.Unsupported,
      now
    );
    return failed(GitHubSyncResultReason.Unsupported);
  }

  const settled = await settleTombstonedPullRequestRefresh(db, {
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    pullRequest: providerResult.value,
    target,
    now,
    trigger: input.trigger ?? GitHubFetchTrigger.UserAction,
  });
  if (!settled) {
    log.warn("[github/sync] Tombstoned PR refresh failed", {
      reason: GitHubServerSyncReason.GuardedWriteFailed,
      branchArtifactId: input.branchArtifactId,
      organizationId: input.organizationId,
    });
    return failed(GitHubServerSyncReason.GuardedWriteFailed);
  }
  return {
    status: GitHubServerSyncStatus.Refreshed,
    reason: GitHubSyncResultReason.Success,
  };
}

async function findBranchSyncTarget(
  db: GitHubServerSyncClient,
  organizationId: string,
  branchArtifactId: string
) {
  return await db.artifact.findFirst({
    where: {
      id: branchArtifactId,
      organizationId,
      type: ArtifactType.BRANCH,
    },
    select: {
      id: true,
      organizationId: true,
      branch: {
        select: {
          repositoryId: true,
          currentPullRequestDetail: {
            select: {
              githubId: true,
              id: true,
              number: true,
            },
          },
          repository: {
            select: {
              id: true,
              fullName: true,
              owner: true,
              name: true,
              private: true,
              removedAt: true,
              installation: {
                select: {
                  organizationId: true,
                  status: true,
                },
              },
            },
          },
        },
      },
    },
  });
}

async function hasOwnedSessionPullRequestReference(
  db: GitHubServerSyncClient,
  input: {
    actorUserId: string;
    branchArtifactId: string;
    organizationId: string;
    pullNumber: number;
    repositoryFullName: string;
  }
): Promise<boolean> {
  const link: { metadata: Prisma.JsonValue | null } | null =
    await db.artifactLink.findFirst({
      where: {
        organizationId: input.organizationId,
        targetId: input.branchArtifactId,
        linkType: LinkType.RelatesTo,
        AND: [
          {
            metadata: {
              path: ["linkKind"],
              equals: SessionArtifactLinkKind.SessionPr,
            },
          },
          {
            metadata: {
              path: ["repositoryFullName"],
              equals: input.repositoryFullName,
            },
          },
          {
            metadata: {
              path: ["prNumber"],
              equals: input.pullNumber,
            },
          },
        ],
        source: {
          organizationId: input.organizationId,
          type: ArtifactType.SESSION,
          session: {
            is: {
              userId: input.actorUserId,
            },
          },
        },
        target: {
          organizationId: input.organizationId,
          type: ArtifactType.BRANCH,
        },
      },
      select: {
        metadata: true,
      },
    });
  return (
    !!link &&
    sessionPrLinkMatches(link.metadata, {
      pullNumber: input.pullNumber,
      repositoryFullName: input.repositoryFullName,
    })
  );
}

async function resolveUserSyncCredential(
  db: GitHubServerSyncClient,
  input: {
    actorUserId: string;
    organizationId: string;
    repositoryPrivate: boolean;
    now: Date;
  }
): Promise<GitHubUserSyncCredential> {
  const connection = await db.gitHubUserConnection.findUnique({
    where: {
      organizationId_userId: {
        organizationId: input.organizationId,
        userId: input.actorUserId,
      },
    },
    select: {
      id: true,
      accessTokenEncrypted: true,
      revokedAt: true,
      tokenExpiresAt: true,
      scopes: true,
    },
  });
  if (!connection) {
    return { ok: false, reason: GitHubSyncResultReason.NoCredential };
  }
  if (connection.revokedAt !== null) {
    return { ok: false, reason: GitHubSyncResultReason.CredentialRevoked };
  }
  if (
    connection.tokenExpiresAt &&
    connection.tokenExpiresAt.getTime() <= input.now.getTime()
  ) {
    return { ok: false, reason: GitHubSyncResultReason.CredentialExpired };
  }
  if (!hasRequiredReadScope(connection.scopes, input.repositoryPrivate)) {
    return {
      ok: false,
      reason: GitHubSyncResultReason.CredentialInsufficientScope,
    };
  }

  let token: string;
  try {
    token = await decryptIntegrationToken(connection.accessTokenEncrypted);
  } catch (error) {
    log.warn("[github/sync] Failed to decrypt GitHub user token", {
      error,
      organizationId: input.organizationId,
      userId: input.actorUserId,
    });
    return {
      ok: false,
      reason: GitHubSyncResultReason.CredentialDecryptionFailed,
    };
  }

  const updated = await db.gitHubUserConnection.updateMany({
    where: {
      id: connection.id,
      organizationId: input.organizationId,
      userId: input.actorUserId,
      revokedAt: null,
    },
    data: { lastUsedAt: input.now },
  });
  if (updated.count !== 1) {
    return { ok: false, reason: GitHubSyncResultReason.CredentialRevoked };
  }
  return { ok: true, token };
}

async function claimTombstonedPullRequestRefresh(
  db: GitHubServerSyncClient,
  organizationId: string,
  target: BranchSyncTarget,
  now: Date
): Promise<boolean> {
  const currentPullRequest = target.branch.currentPullRequestDetail;
  if (!currentPullRequest) {
    return false;
  }
  // Non-App branches (PRD-510 D2/FR8) have no installation-repo-keyed PR to
  // claim; only tombstoned App repos reach the user-token refresh path.
  const repositoryId = target.branch.repositoryId;
  if (!repositoryId) {
    return false;
  }
  const staleBefore = new Date(now.getTime() - REFRESH_WINDOW_MS);
  const result = await db.pullRequestDetail.updateMany({
    where: {
      id: currentPullRequest.id,
      branchArtifactId: target.id,
      repositoryId,
      branchArtifact: { organizationId },
      repository: { removedAt: { not: null } },
      currentForBranches: {
        some: {
          artifactId: target.id,
          currentPullRequestDetailId: currentPullRequest.id,
          artifact: { organizationId },
          repository: { removedAt: { not: null } },
        },
      },
      OR: [
        { lastRefreshAttemptAt: null },
        { lastRefreshAttemptAt: { lt: staleBefore } },
      ],
    },
    data: { lastRefreshAttemptAt: now },
  });
  return result.count === 1;
}

async function settleTombstonedPullRequestRefresh(
  db: GitHubServerSyncClient,
  input: {
    actorUserId: string;
    organizationId: string;
    pullRequest: GitHubSinglePullRequestResult;
    target: BranchSyncTarget;
    now: Date;
    trigger: GitHubFetchTriggerValue;
  }
): Promise<boolean> {
  const currentPullRequest = input.target.branch.currentPullRequestDetail;
  if (!currentPullRequest) {
    return false;
  }
  // Non-App branches (PRD-510 D2/FR8) have no installation-repo-keyed PR to
  // settle; only tombstoned App repos reach the user-token refresh path.
  const repositoryId = input.target.branch.repositoryId;
  if (!repositoryId) {
    return false;
  }
  const provenance = gitHubFetchProvenanceData(
    userOAuthRestFetchProvenance({
      credentialOwnerId: input.actorUserId,
      resultReason: GitHubSyncResultReason.Success,
      trigger: input.trigger,
    })
  );
  const result = await db.pullRequestDetail.updateMany({
    where: {
      id: currentPullRequest.id,
      branchArtifactId: input.target.id,
      repositoryId,
      branchArtifact: { organizationId: input.organizationId },
      repository: { removedAt: { not: null } },
      currentForBranches: {
        some: {
          artifactId: input.target.id,
          currentPullRequestDetailId: currentPullRequest.id,
          artifact: { organizationId: input.organizationId },
          repository: { removedAt: { not: null } },
        },
      },
    },
    data: {
      prState: input.pullRequest.state,
      title: input.pullRequest.title,
      htmlUrl: input.pullRequest.htmlUrl,
      isDraft: input.pullRequest.isDraft,
      closedAt: parseNullableDate(input.pullRequest.closedAt),
      mergedAt: parseNullableDate(input.pullRequest.mergedAt),
      mergeCommitSha: input.pullRequest.mergeCommitSha,
      ...pullRequestLocData(input.pullRequest),
      lastVerifiedAt: input.now,
      ...provenance,
    },
  });
  if (result.count !== 1) {
    return false;
  }
  const branchActivityAt = pullRequestActivityDate(input.pullRequest);
  const branchResult = await db.branchDetail.updateMany({
    where: {
      artifactId: input.target.id,
      repositoryId,
      artifact: { organizationId: input.organizationId },
      repository: { removedAt: { not: null } },
    },
    data: {
      baseBranch: input.pullRequest.baseBranch,
      headSha: input.pullRequest.headSha,
      headShaObservedAt: input.now,
      ...(branchActivityAt ? { lastActivityAt: branchActivityAt } : {}),
      ...provenance,
    },
  });
  return branchResult.count === 1;
}

async function stampTombstonedRefreshFailure(
  db: GitHubServerSyncClient,
  input: RefreshTombstonedBranchPullRequestInput,
  target: BranchSyncTarget,
  reason: GitHubSyncResultReasonValue,
  now: Date,
  options: { recordRefreshAttempt?: boolean } = {}
): Promise<void> {
  const provenance = gitHubFetchProvenanceData(
    userOAuthRestFetchProvenance({
      credentialOwnerId: input.actorUserId,
      resultReason: reason,
      trigger: input.trigger ?? GitHubFetchTrigger.UserAction,
    })
  );
  const currentPullRequest = target.branch.currentPullRequestDetail;
  // Non-App branches (PRD-510 D2/FR8) have no installation-repo-keyed PR row to
  // stamp; skip that write. Only tombstoned App repos reach this failure path.
  const repositoryId = target.branch.repositoryId;
  if (currentPullRequest && repositoryId) {
    await db.pullRequestDetail.updateMany({
      where: {
        id: currentPullRequest.id,
        branchArtifactId: target.id,
        repositoryId,
        branchArtifact: { organizationId: input.organizationId },
        repository: { removedAt: { not: null } },
      },
      data: {
        ...(options.recordRefreshAttempt === false
          ? {}
          : { lastRefreshAttemptAt: now }),
        ...provenance,
      },
    });
  }
  await db.branchDetail.updateMany({
    where: {
      artifactId: target.id,
      repositoryId,
      artifact: { organizationId: input.organizationId },
      repository: { removedAt: { not: null } },
    },
    data: provenance,
  });
}

function hasActiveRepository(target: BranchSyncTarget): boolean {
  const repository = target.branch.repository;
  // Non-App branch (PRD-510 D2/FR8): no installation-repo, so no active repo.
  if (!repository) {
    return false;
  }
  return (
    repository.removedAt === null &&
    repository.installation.organizationId === target.organizationId &&
    repository.installation.status === GitHubInstallationStatus.ACTIVE
  );
}

function isTombstonedRepository(
  target: BranchSyncTarget
): target is BranchSyncTargetWithRepository {
  const repository = target.branch.repository;
  // Non-App branch: no installation-repo relation, so nothing is "tombstoned".
  if (!repository) {
    return false;
  }
  return repository.removedAt !== null;
}

function hasBranchDetail(
  target: BranchSyncTargetRecord | null
): target is BranchSyncTarget {
  return target?.branch !== null && target?.branch !== undefined;
}

function sessionPrLinkMatches(
  metadata: Prisma.JsonValue | null,
  input: { pullNumber: number; repositoryFullName: string }
): boolean {
  const parsed = SESSION_PR_LINK_METADATA_SCHEMA.safeParse(metadata);
  if (!parsed.success) {
    return false;
  }
  return (
    parsed.data.repositoryFullName === input.repositoryFullName &&
    parsed.data.prNumber === input.pullNumber
  );
}

function hasRequiredReadScope(
  scopes: readonly string[],
  repositoryPrivate: boolean
): boolean {
  if (scopes.includes("repo")) {
    return true;
  }
  return !repositoryPrivate && scopes.includes("public_repo");
}

function parseRepositoryFullName(
  fullName: string
): { owner: string; name: string } | null {
  const [owner, name, ...extra] = fullName.split("/");
  if (!(owner && name) || extra.length > 0) {
    return null;
  }
  return { owner, name };
}

function parseNullableDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function pullRequestActivityDate(
  pullRequest: GitHubSinglePullRequestResult
): Date | null {
  return maxNullableDate(
    parseNullableDate(pullRequest.mergedAt),
    parseNullableDate(pullRequest.closedAt)
  );
}

function maxNullableDate(...values: (Date | null)[]): Date | null {
  const concrete = values.filter((value): value is Date => value !== null);
  if (concrete.length === 0) {
    return null;
  }
  return new Date(Math.max(...concrete.map((value) => value.getTime())));
}

function retryable(
  reason:
    | typeof GitHubServerSyncReason.AlreadyRefreshing
    | typeof GitHubServerSyncReason.ProviderRateLimited
    | typeof GitHubServerSyncReason.ProviderUnavailable,
  retryAfterSeconds?: number
): GitHubServerSyncResult {
  return {
    status: GitHubServerSyncStatus.Retryable,
    reason,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

function failed(
  reason: Extract<
    GitHubServerSyncResult,
    { status: typeof GitHubServerSyncStatus.Failed }
  >["reason"]
): GitHubServerSyncResult {
  return { status: GitHubServerSyncStatus.Failed, reason };
}

function notApplicable(
  reason: Extract<
    GitHubServerSyncResult,
    { status: typeof GitHubServerSyncStatus.NotApplicable }
  >["reason"]
): GitHubServerSyncResult {
  return { status: GitHubServerSyncStatus.NotApplicable, reason };
}
