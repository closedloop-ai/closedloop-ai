import { parseRepositoryFullName } from "@repo/api/src/types/branch-repository";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchTrigger,
  type GitHubFetchTrigger as GitHubFetchTriggerValue,
  GitHubSyncResultReason,
  type GitHubSyncResultReason as GitHubSyncResultReasonValue,
} from "@repo/api/src/types/github-read-model";
import {
  ArtifactType,
  GitHubInstallationStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import {
  GitHubProviderResultStatus,
  type GitHubSinglePullRequestResult,
  GitHubUserTokenProviderResultStatus,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import { log } from "@repo/observability/log";
import {
  branchOwnsPullRequestDetail,
  TOMBSTONED_REPOSITORY_WHERE,
  type TombstonedRepositoryIdentity,
  tombstonedRepositoryWhere,
} from "@/app/branches/branch-canonical-pull-request";
import {
  cloudBranchCanonicalPullRequestSelect,
  resolveCloudBranchCanonicalDetail,
} from "@/app/branches/branch-canonical-pull-request-cloud";
import { seedBranchOwners } from "@/app/branches/branch-owner-seed/branch-owner-seed";
import { ensurePullRequestAuthorIdentity } from "@/app/branches/pull-request-author-identity";
import {
  createPullRequestRestAuthorityProvenance,
  persistPullRequestProviderFailure,
  toPullRequestRestAuthorityObservation,
} from "@/app/branches/pull-request-authority-producer";
import {
  needsGitHubHeadRefile,
  pullRequestGitHubHead,
} from "@/app/branches/pull-request-github-head-filing";
import { refilePullRequestUnderGitHubHead } from "@/app/branches/pull-request-github-head-refile";
import {
  persistPullRequestHeadRepositoryAuthority,
  pullRequestHeadRepositoryObservation,
} from "@/app/branches/pull-request-head-authority";
import {
  PullRequestLifecycleActivityPersistenceError,
  persistPullRequestLifecycleActivityInTransaction,
} from "@/app/branches/pull-request-lifecycle-activity";
import { resolveGitHubUserCredential } from "@/lib/github/github-user-credential";
import {
  gitHubFetchProvenanceData,
  userOAuthRestFetchProvenance,
} from "@/lib/github-fetch-provenance";
import {
  parseNullableDate,
  tombstonedPullRequestSettleData,
} from "./tombstoned-pr-settle-data";
import { hasOwnedSessionPullRequestReference } from "./user-token-pull-request-authorization";

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
  | "repositoryDefaultObservationReceipt"
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

/**
 * `CredentialExpired`/`CredentialDecryptionFailed` are deliberately absent:
 * both described the stored token this lane no longer reads. They survive in
 * `GitHubSyncResultReason` as accept-only wire values, so `toBranchRefreshReason`
 * still maps them.
 */
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
        | typeof GitHubSyncResultReason.CredentialInsufficientScope;
    };

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

  const currentPullRequest = syncTargetCanonicalPullRequest(target);
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

  const credential = await resolveUserSyncCredential({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
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

  const authorityProvenance = createPullRequestRestAuthorityProvenance({
    credentialType: GitHubFetchCredentialType.UserOAuth,
    credentialOwnerId: input.actorUserId,
    observedAt: now,
    trigger: input.trigger ?? GitHubFetchTrigger.UserAction,
  });
  const providerResult = await getSinglePullRequestWithProviderResult(
    getUserTokenOctokit(credential.token),
    repositoryIdentity.owner,
    repositoryIdentity.repo,
    currentPullRequest.number,
    toPullRequestRestAuthorityObservation(authorityProvenance)
  );
  if (providerResult.status === GitHubProviderResultStatus.ProviderRateLimit) {
    await persistPullRequestProviderFailure(
      db,
      {
        organizationId: input.organizationId,
        pullRequestDetailId: currentPullRequest.id,
      },
      providerResult,
      authorityProvenance
    );
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
    await persistPullRequestProviderFailure(
      db,
      {
        organizationId: input.organizationId,
        pullRequestDetailId: currentPullRequest.id,
      },
      providerResult,
      authorityProvenance
    );
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
    await persistPullRequestProviderFailure(
      db,
      {
        organizationId: input.organizationId,
        pullRequestDetailId: currentPullRequest.id,
      },
      providerResult,
      authorityProvenance
    );
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
    await persistPullRequestProviderFailure(
      db,
      {
        organizationId: input.organizationId,
        pullRequestDetailId: currentPullRequest.id,
      },
      providerResult,
      authorityProvenance
    );
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

  const settled = await settleTombstonedPullRequestRefresh({
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
      pullRequestDetails: {
        // ISS-8901: `removedAt` on top of the shared canonical select. This
        // lane's guarded writes require the PR's OWN repository to be
        // tombstoned, so the gate has to be able to see it.
        select: {
          ...cloudBranchCanonicalPullRequestSelect,
          repository: {
            select: { fullName: true, githubRepoId: true, removedAt: true },
          },
        },
      },
      branch: {
        select: {
          branchName: true,
          repositoryId: true,
          currentPullRequestDetailId: true,
          repositoryFullName: true,
          repository: {
            select: {
              id: true,
              fullName: true,
              githubRepoId: true,
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

/**
 * PLN-1742: acquisition is the shared one (Clerk, the only user-credential
 * source since the M5 tail); this function owns only the translation into the
 * sync lane's own reason vocabulary, and the scope floor — which is now the
 * SAME predicate the pool applies. The two used to disagree: this lane
 * demanded `repo` (or `public_repo` on a public repository) outright, so it
 * rejected every App-family token, whose reach is governed by the installation
 * and which reports no scopes at all.
 */
async function resolveUserSyncCredential(input: {
  actorUserId: string;
  organizationId: string;
  now: Date;
}): Promise<GitHubUserSyncCredential> {
  const read = await resolveGitHubUserCredential({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    now: input.now,
  });
  if (!read.ok) {
    return { ok: false, reason: mapSyncCredentialDenial(read.denial) };
  }
  return { ok: true, token: read.credential.token };
}

function mapSyncCredentialDenial(
  denial: GitHubAccessDenialReason
): Exclude<GitHubUserSyncCredential, { ok: true }>["reason"] {
  if (denial === GitHubAccessDenialReason.InsufficientScope) {
    return GitHubSyncResultReason.CredentialInsufficientScope;
  }
  if (denial === GitHubAccessDenialReason.Revoked) {
    return GitHubSyncResultReason.CredentialRevoked;
  }
  // No linked account, and the transient reasons (Clerk or GitHub unreachable,
  // rate limited) that used to reach the stored fallback and land here as
  // `no_credential` once the token-less row classified `not_connected`.
  // `credential_expired` and `credential_decryption_failed` are NOT produced:
  // both described the stored cipher, which this lane no longer reads.
  return GitHubSyncResultReason.NoCredential;
}

async function claimTombstonedPullRequestRefresh(
  db: GitHubServerSyncClient,
  organizationId: string,
  target: BranchSyncTarget,
  now: Date
): Promise<boolean> {
  const currentPullRequest = syncTargetCanonicalPullRequest(target);
  if (!currentPullRequest) {
    return false;
  }
  // Non-App branches (PRD-510 D2/FR8) carry no installation-repo relation, so
  // there is no tombstoned repository to key the claim on; only tombstoned App
  // repos reach the user-token refresh path.
  const repository = target.branch.repository;
  if (!repository) {
    return false;
  }
  // ISS-8901: the claim is the FIRST of this lane's three guarded writes, so it
  // has to move with the other two. Left on the surrogate id it would reject a
  // reinstall-split branch before the settle write it gates ever ran, turning
  // the clean `not_applicable` the old ownership predicate produced into a
  // `GuardedWriteFailed` — strictly worse than not fixing the lane at all.
  const repositoryWhere = tombstonedRepositoryWhere(repository);
  const staleBefore = new Date(now.getTime() - REFRESH_WINDOW_MS);
  const result = await db.pullRequestDetail.updateMany({
    where: {
      id: currentPullRequest.id,
      branchArtifactId: target.id,
      branchArtifact: {
        organizationId,
        branch: { is: { repository: repositoryWhere } },
      },
      repository: repositoryWhere,
      OR: [
        { lastRefreshAttemptAt: null },
        { lastRefreshAttemptAt: { lt: staleBefore } },
      ],
    },
    data: { lastRefreshAttemptAt: now },
  });
  return result.count === 1;
}

async function settleTombstonedPullRequestRefresh(input: {
  actorUserId: string;
  organizationId: string;
  pullRequest: GitHubSinglePullRequestResult;
  target: BranchSyncTarget;
  now: Date;
  trigger: GitHubFetchTriggerValue;
}): Promise<boolean> {
  const currentPullRequest = syncTargetCanonicalPullRequest(input.target);
  if (!currentPullRequest) {
    return false;
  }
  // Non-App branches (PRD-510 D2/FR8) carry no installation-repo relation, so
  // there is no tombstoned repository for the guarded writes to key on; only
  // tombstoned App repos reach the user-token refresh path.
  const repository = input.target.branch.repository;
  if (!repository) {
    return false;
  }
  try {
    await withDb.tx(async (tx) => {
      const settled = await settleTombstonedPullRequestRefreshInTransaction(
        tx,
        input,
        repository
      );
      if (!settled) {
        throw new TombstonedSettlementGuardError();
      }
      // ISS-12463: the settle write may be the PR's first author login. The
      // seed's first stamp is final, so a PR the refile below moves (which
      // seeds its head Branch) must not stamp the Branch it leaves.
      if (
        !needsGitHubHeadRefile(
          {
            repositoryFullName: repository.fullName,
            branch: input.target.branch,
          },
          pullRequestGitHubHead(input.pullRequest)
        )
      ) {
        await seedBranchOwners(tx, input.organizationId, [input.target.id]);
      }
    });
  } catch (error) {
    if (
      error instanceof TombstonedSettlementGuardError ||
      error instanceof PullRequestLifecycleActivityPersistenceError
    ) {
      return false;
    }
    throw error;
  }
  await refilePullRequestUnderGitHubHead(
    input.organizationId,
    currentPullRequest.id,
    input.pullRequest
  );
  return true;
}

async function settleTombstonedPullRequestRefreshInTransaction(
  db: TransactionClient,
  input: {
    actorUserId: string;
    organizationId: string;
    pullRequest: GitHubSinglePullRequestResult;
    target: BranchSyncTarget;
    now: Date;
    trigger: GitHubFetchTriggerValue;
  },
  repository: TombstonedRepositoryIdentity
): Promise<boolean> {
  const currentPullRequest = syncTargetCanonicalPullRequest(input.target);
  if (!currentPullRequest) {
    return false;
  }
  // Both writes use the same provider-first identity as ownership so rename and
  // reinstall splits settle without widening past a conflicting provider id.
  const repositoryWhere = tombstonedRepositoryWhere(repository);
  const fetchProvenance = userOAuthRestFetchProvenance({
    credentialOwnerId: input.actorUserId,
    resultReason: GitHubSyncResultReason.Success,
    trigger: input.trigger,
  });
  const result = await db.pullRequestDetail.updateMany({
    where: {
      id: currentPullRequest.id,
      branchArtifactId: input.target.id,
      lastRefreshAttemptAt: input.now,
      branchArtifact: {
        organizationId: input.organizationId,
        branch: {
          is: {
            repository: repositoryWhere,
            // Pointer-MOVEMENT CAS (PR #6453 review). This is deliberately not
            // the `currentPullRequestDetailId === <row being refreshed>` term
            // ISS-8522 removed: that one rejected exactly the stale and
            // never-promoted pointers this lane exists to heal. This compares
            // the pointer against the value snapshotted with the target, so a
            // stale or null pointer still settles, while a webhook that
            // PROMOTES a sibling during the provider fetch moves the column,
            // matches zero rows, and aborts before either write lands.
            currentPullRequestDetailId:
              input.target.branch.currentPullRequestDetailId,
          },
        },
      },
      repository: repositoryWhere,
    },
    data: tombstonedPullRequestSettleData(
      input.pullRequest,
      input.now,
      fetchProvenance
    ),
  });
  if (result.count !== 1) {
    return false;
  }
  await ensurePullRequestAuthorIdentity(db, {
    organizationId: input.organizationId,
    githubId: input.pullRequest.githubId,
    authorProviderUserId: input.pullRequest.authorProviderUserId,
    authorLogin: input.pullRequest.authorLogin,
    authorActorType: input.pullRequest.authorActorType,
  });
  await persistPullRequestHeadRepositoryAuthority(
    db,
    {
      organizationId: input.organizationId,
      pullRequestDetailId: currentPullRequest.id,
    },
    pullRequestHeadRepositoryObservation(input.pullRequest),
    {
      name: input.pullRequest.headBranch,
      oid: input.pullRequest.headSha,
    }
  );
  await persistPullRequestLifecycleActivityInTransaction(db, {
    organizationId: input.organizationId,
    branchArtifactId: input.target.id,
    pullRequestDetailId: currentPullRequest.id,
    openedAt: parseNullableDate(input.pullRequest.createdAt),
    mergedAt: parseNullableDate(input.pullRequest.mergedAt),
    closedAt: parseNullableDate(input.pullRequest.closedAt),
  });
  // Claim exclusivity is INHERITED from the detail update above, whose
  // `count !== 1` throws out of this transaction before reaching here.
  // Reordering these two statements, or downgrading that throw, reopens a
  // double-write window that nothing else here would catch. The pointer term
  // below is the second guard and is this statement's own: it is what stops a
  // concurrent promotion from taking this row's base branch and head SHA onto a
  // branch that is no longer represented by it.
  const branchResult = await db.branchDetail.updateMany({
    where: {
      artifactId: input.target.id,
      currentPullRequestDetailId:
        input.target.branch.currentPullRequestDetailId,
      artifact: { organizationId: input.organizationId },
      repository: repositoryWhere,
    },
    data: {
      baseBranch: input.pullRequest.baseBranch,
      headSha: input.pullRequest.headSha,
      headShaObservedAt: input.now,
      ...gitHubFetchProvenanceData(fetchProvenance),
    },
  });
  return branchResult.count === 1;
}

class TombstonedSettlementGuardError extends Error {
  constructor() {
    super("Tombstoned pull request settlement guard was lost");
    this.name = "TombstonedSettlementGuardError";
  }
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
  const currentPullRequest = syncTargetCanonicalPullRequest(target);
  // Non-App branches (PRD-510 D2/FR8) carry no installation-repo relation, so
  // there is no tombstoned repository to key the PR-row stamp on; skip that
  // write. Only tombstoned App repos reach this failure path.
  const repository = target.branch.repository;
  const repositoryWhere = repository
    ? tombstonedRepositoryWhere(repository)
    : null;
  if (currentPullRequest && repositoryWhere) {
    await db.pullRequestDetail.updateMany({
      where: {
        id: currentPullRequest.id,
        branchArtifactId: target.id,
        branchArtifact: { organizationId: input.organizationId },
        repository: repositoryWhere,
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
      artifact: { organizationId: input.organizationId },
      // A branch with no installation-repo relation matches nothing here, which
      // is the same fail-closed outcome the surrogate-id term produced.
      repository: repositoryWhere ?? TOMBSTONED_REPOSITORY_WHERE,
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

/**
 * The PR this tombstoned-refresh lane speaks for. ISS-8522: derived from the
 * branch's own rows, so a branch whose pointer is stale or was never promoted
 * refreshes its real PR instead of reading as having none. Target and every
 * guarded write below key on the row id this returns, never on the pointer, so
 * the two cannot disagree mid-refresh.
 */
function syncTargetCanonicalPullRequest(
  target: BranchSyncTarget
): { id: string; number: number; githubId: string | null } | null {
  const detail = resolveCloudBranchCanonicalDetail({
    id: target.id,
    currentPullRequestDetailId: target.branch.currentPullRequestDetailId,
    branch: target.branch,
    pullRequestDetails: target.pullRequestDetails,
  }).detail;
  // The canonical population is keyed on `branchArtifactId` alone, which the
  // schema does not constrain to agree with the branch's repository. This lane
  // spends a USER's OAuth token on `<branch repo>#<this number>`, so a row whose
  // repository disagrees would read a stranger's PR in that namespace. Fail
  // closed instead of relying on the downstream `githubId` compare to notice.
  if (!(detail && branchOwnsPullRequestDetail(target.branch, detail))) {
    return null;
  }
  // The row itself must remain tombstoned even when provider identity follows a
  // rename or reinstall; user OAuth must not settle a live App-covered row.
  if (detail.repository?.removedAt == null) {
    return null;
  }
  return detail;
}
