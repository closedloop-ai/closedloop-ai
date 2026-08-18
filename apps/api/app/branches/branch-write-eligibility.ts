import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  normalizePersistedRepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import {
  GitHubInstallationStatus,
  Prisma,
  type TransactionClient,
} from "@repo/database";
import { isCloudBranchEligible } from "./cloud-branch-eligibility";
import type { PullRequestHeadRepositoryObservation } from "./pull-request-head-authority";

type BranchWriteEligibilityInput = {
  organizationId: string;
  repositoryId?: string | null;
  repositoryFullName: string;
  branchName: string;
  repositoryDefaultObservation?: PullRequestHeadRepositoryObservation;
};

type BranchWriteEligibilityClient = Pick<TransactionClient, "$queryRaw">;

export const CloudBranchNonMaterializationKind = {
  AuthorityUnavailable: "authority_unavailable",
  ConflictingAuthority: "conflicting_authority",
  DefaultBranch: "default_branch",
  IdentityMismatch: "identity_mismatch",
} as const;
export type CloudBranchNonMaterializationKind =
  (typeof CloudBranchNonMaterializationKind)[keyof typeof CloudBranchNonMaterializationKind];

export type CloudBranchWriteEligibility =
  | { kind: "eligible" }
  | {
      kind: "not_materialized";
      cause: CloudBranchNonMaterializationKind;
      reason: RepositoryDefaultReason;
    };

type PersistedAuthorityRow = {
  githubRepoId: string;
  fullName: string;
  defaultBranchName: string | null;
  defaultBranchAvailability: string | null;
  defaultBranchCompleteness: string | null;
  defaultBranchReason: string | null;
  defaultBranchSource: string | null;
  defaultBranchMechanism: string | null;
  defaultBranchTrigger: string | null;
  defaultBranchCredentialType: string | null;
  defaultBranchCredentialOwnerId: string | null;
  defaultBranchObservationKey: string | null;
  defaultBranchObservedAt: Date | null;
  defaultBranchEventAt: Date | null;
};

/**
 * Resolves the canonical provider-owned default authority before any Branch
 * write. Fresh observations participate in the same persisted reconciliation;
 * they never replace provider identity with caller-supplied identity.
 */
export async function resolveCloudBranchWriteEligibility(
  tx: BranchWriteEligibilityClient,
  input: BranchWriteEligibilityInput
): Promise<CloudBranchWriteEligibility> {
  const repositoryFullName = normalizeRepoFullName(input.repositoryFullName);
  const persistedRows = await readPersistedAuthorityRows(
    tx,
    input,
    repositoryFullName
  );
  if (input.repositoryId && persistedRows.length !== 1) {
    return notMaterialized(
      CloudBranchNonMaterializationKind.IdentityMismatch,
      RepositoryDefaultReason.Malformed
    );
  }
  if (
    persistedRows.some(
      (repository) =>
        normalizeRepoFullName(repository.fullName) !== repositoryFullName
    )
  ) {
    return notMaterialized(
      CloudBranchNonMaterializationKind.IdentityMismatch,
      RepositoryDefaultReason.Malformed
    );
  }

  const persistedAuthorities = persistedRows
    .map(toPersistedAuthority)
    .filter(
      (authority): authority is NormalizedPersistedRepositoryDefaultAuthority =>
        authority !== undefined
    );
  const incoming = input.repositoryDefaultObservation;
  if (incoming?.authority && incoming.unavailable) {
    return notMaterialized(
      CloudBranchNonMaterializationKind.ConflictingAuthority,
      RepositoryDefaultReason.Conflicting
    );
  }
  if (
    incoming?.authority &&
    (incoming.authority.repository.provider !== VcsProviderKind.GitHub ||
      normalizeRepoFullName(incoming.authority.repository.fullName) !==
        repositoryFullName)
  ) {
    return notMaterialized(
      CloudBranchNonMaterializationKind.IdentityMismatch,
      RepositoryDefaultReason.Malformed
    );
  }

  const providerRepositoryIds = new Set(
    persistedAuthorities.map(
      (authority) => authority.repository.providerRepositoryId
    )
  );
  if (incoming?.authority) {
    providerRepositoryIds.add(
      incoming.authority.repository.providerRepositoryId
    );
  }
  if (providerRepositoryIds.size > 1) {
    return notMaterialized(
      CloudBranchNonMaterializationKind.ConflictingAuthority,
      RepositoryDefaultReason.Conflicting
    );
  }

  const authorities = [...persistedAuthorities];
  if (incoming?.authority) {
    authorities.push(incoming.authority);
  } else if (incoming?.unavailable) {
    const retainedIdentity = persistedAuthorities[0]?.repository;
    if (!retainedIdentity) {
      return notMaterialized(
        CloudBranchNonMaterializationKind.AuthorityUnavailable,
        incoming.unavailable.reason
      );
    }
    authorities.push({
      repository: retainedIdentity,
      evidence: {
        availability: RepositoryDefaultAvailability.Unavailable,
        completeness: RepositoryDefaultCompleteness.Unavailable,
        reason: incoming.unavailable.reason,
      },
      provenance: incoming.unavailable.provenance,
    });
  }

  if (authorities.length === 0) {
    return notMaterialized(
      CloudBranchNonMaterializationKind.AuthorityUnavailable,
      RepositoryDefaultReason.NotReported
    );
  }
  const providerRepositoryId = [...providerRepositoryIds][0];
  if (!providerRepositoryId) {
    return notMaterialized(
      CloudBranchNonMaterializationKind.IdentityMismatch,
      RepositoryDefaultReason.Malformed
    );
  }
  if (
    isCloudBranchEligible({
      branchName: input.branchName,
      repository: {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId,
        fullName: repositoryFullName,
      },
      authorities,
    })
  ) {
    return { kind: "eligible" };
  }

  const defaultBranch = newestAvailableDefault(authorities);
  if (defaultBranch === input.branchName) {
    return notMaterialized(
      CloudBranchNonMaterializationKind.DefaultBranch,
      RepositoryDefaultReason.Ambiguous
    );
  }
  return notMaterialized(
    CloudBranchNonMaterializationKind.AuthorityUnavailable,
    newestAuthorityReason(authorities)
  );
}

async function readPersistedAuthorityRows(
  tx: BranchWriteEligibilityClient,
  input: BranchWriteEligibilityInput,
  repositoryFullName: string
): Promise<PersistedAuthorityRow[]> {
  if (input.repositoryId) {
    return tx.$queryRaw<PersistedAuthorityRow[]>(Prisma.sql`
      SELECT ${persistedAuthorityColumns()}
      FROM github_installation_repositories repository
      INNER JOIN github_installations installation
        ON installation.id = repository.installation_id
      WHERE repository.id = ${input.repositoryId}::uuid
        AND repository.removed_at IS NULL
        AND installation.organization_id = ${input.organizationId}::uuid
        AND installation.status = ${GitHubInstallationStatus.ACTIVE}::"GitHubInstallationStatus"
      FOR SHARE OF repository, installation
    `);
  }
  const [installationRepositories, publicRepositories] = await Promise.all([
    tx.$queryRaw<PersistedAuthorityRow[]>(Prisma.sql`
      SELECT ${persistedAuthorityColumns()}
      FROM github_installation_repositories repository
      INNER JOIN github_installations installation
        ON installation.id = repository.installation_id
      WHERE installation.organization_id = ${input.organizationId}::uuid
        AND installation.status = ${GitHubInstallationStatus.ACTIVE}::"GitHubInstallationStatus"
        AND repository.removed_at IS NULL
        AND LOWER(repository.full_name) = ${repositoryFullName}
      FOR SHARE OF repository, installation
    `),
    tx.$queryRaw<PersistedAuthorityRow[]>(Prisma.sql`
      SELECT ${persistedAuthorityColumns()}
      FROM public_repositories repository
      WHERE repository.organization_id = ${input.organizationId}::uuid
        AND LOWER(repository.full_name) = ${repositoryFullName}
      FOR SHARE OF repository
    `),
  ]);
  return [...installationRepositories, ...publicRepositories];
}

function persistedAuthorityColumns(): Prisma.Sql {
  return Prisma.sql`
    repository.github_repo_id AS "githubRepoId",
    repository.full_name AS "fullName",
    repository.default_branch_name AS "defaultBranchName",
    repository.default_branch_availability AS "defaultBranchAvailability",
    repository.default_branch_completeness AS "defaultBranchCompleteness",
    repository.default_branch_reason AS "defaultBranchReason",
    repository.default_branch_source AS "defaultBranchSource",
    repository.default_branch_mechanism AS "defaultBranchMechanism",
    repository.default_branch_trigger AS "defaultBranchTrigger",
    repository.default_branch_credential_type AS "defaultBranchCredentialType",
    repository.default_branch_credential_owner_id AS "defaultBranchCredentialOwnerId",
    repository.default_branch_observation_key AS "defaultBranchObservationKey",
    repository.default_branch_observed_at AS "defaultBranchObservedAt",
    repository.default_branch_event_at AS "defaultBranchEventAt"
  `;
}

function toPersistedAuthority(
  repository: PersistedAuthorityRow
): NormalizedPersistedRepositoryDefaultAuthority | undefined {
  return normalizePersistedRepositoryDefaultAuthority(
    {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: repository.githubRepoId,
      fullName: repository.fullName,
    },
    repository
  );
}

function newestAvailableDefault(
  authorities: readonly NormalizedPersistedRepositoryDefaultAuthority[]
): string | undefined {
  const sorted = [...authorities].sort(
    (left, right) => authorityTime(right) - authorityTime(left)
  );
  const evidence = sorted[0]?.evidence;
  return evidence && "defaultBranch" in evidence
    ? evidence.defaultBranch
    : undefined;
}

function newestAuthorityReason(
  authorities: readonly NormalizedPersistedRepositoryDefaultAuthority[]
): RepositoryDefaultReason {
  const sorted = [...authorities].sort(
    (left, right) => authorityTime(right) - authorityTime(left)
  );
  const evidence = sorted[0]?.evidence;
  return evidence && "reason" in evidence
    ? evidence.reason
    : RepositoryDefaultReason.Unknown;
}

function authorityTime(
  authority: NormalizedPersistedRepositoryDefaultAuthority
): number {
  const observedAt = Date.parse(authority.provenance?.observedAt ?? "");
  return Number.isFinite(observedAt) ? observedAt : Number.POSITIVE_INFINITY;
}

function notMaterialized(
  cause: CloudBranchNonMaterializationKind,
  reason: RepositoryDefaultReason
): CloudBranchWriteEligibility {
  return { kind: "not_materialized", cause, reason };
}
