import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import type { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { ArtifactType, GitHubInstallationStatus, Prisma } from "@repo/database";
import { branchLinkedSessionExistsSql } from "./branch-contribution-sql";

export type CloudBranchRepositoryIdentity = {
  provider: VcsProviderKind;
  providerRepositoryId?: string;
  fullName: string;
};

export type CloudBranchEligibilityInput = {
  branchName: string;
  repository: CloudBranchRepositoryIdentity;
  authorities: readonly NormalizedPersistedRepositoryDefaultAuthority[];
};

type CloudBranchEligibilityClient = {
  $queryRaw: <T>(query: Prisma.Sql) => Promise<T>;
};

type LatestAuthority = {
  authority: NormalizedPersistedRepositoryDefaultAuthority;
  eventAt: number | null;
  observedAt: number;
};

/**
 * Canonical fail-closed cloud Branch decision over provider-qualified default
 * authority. The newest observation wins; invalid newest evidence is never
 * replaced by an older plausible value, and tied observations must agree.
 */
export function isCloudBranchEligible(
  input: CloudBranchEligibilityInput
): boolean {
  const repositoryFullName = normalizeRepoFullName(input.repository.fullName);
  const matchingAuthorities = input.authorities.filter(
    (authority) =>
      authority.repository.provider === input.repository.provider &&
      normalizeRepoFullName(authority.repository.fullName) ===
        repositoryFullName
  );
  if (matchingAuthorities.length === 0) {
    return false;
  }
  // An all-null migration-era group is absence, not an observation that can
  // outrank fresh provider evidence. It still fails closed when it is the only
  // matching source. Partially populated or corrupt undated groups are kept so
  // they cannot be rescued by an older plausible value.
  const observedAuthorities = matchingAuthorities.filter(
    (authority) => !isLegacyAuthorityAbsence(authority)
  );
  if (observedAuthorities.length === 0) {
    return false;
  }
  const matching = observedAuthorities.map(toDatedAuthority);
  if (matching.some((authority) => authority === null)) {
    return false;
  }
  const dated = matching.filter(
    (authority): authority is LatestAuthority => authority !== null
  );

  const newestAuthorityAt = Math.max(
    ...dated.map((authority) => authority.eventAt ?? authority.observedAt)
  );
  const newest = dated.filter(
    (authority) =>
      (authority.eventAt ?? authority.observedAt) === newestAuthorityAt
  );
  const first = newest[0]?.authority;
  if (!(first && isCompleteAvailableAuthority(first))) {
    return false;
  }
  if (
    input.repository.providerRepositoryId &&
    first.repository.providerRepositoryId !==
      input.repository.providerRepositoryId
  ) {
    return false;
  }
  if (!newest.every(({ authority }) => authoritiesAgree(first, authority))) {
    return false;
  }
  return input.branchName !== first.evidence.defaultBranch;
}

/**
 * Correlated SQL twin of `isCloudBranchEligible`. Callers must alias Artifact as
 * `a` and BranchDetail as `b`; all authority sources remain organization scoped.
 */
export function cloudBranchEligibilitySql(): Prisma.Sql {
  return Prisma.sql`EXISTS (
    WITH repository_default_authorities AS (
      SELECT
        NULL::uuid AS repository_record_id,
        pr.head_repository_github_id AS provider_repository_id,
        LOWER(pr.head_repository_full_name) AS repository_full_name,
        pr.head_repository_default_branch_name AS default_branch_name,
        pr.head_repository_default_branch_availability AS availability,
        pr.head_repository_default_branch_completeness AS completeness,
        pr.head_repository_default_branch_reason AS reason,
        pr.head_repository_default_branch_source AS source,
        pr.head_repository_default_branch_mechanism AS mechanism,
        pr.head_repository_default_branch_trigger AS trigger,
        pr.head_repository_default_branch_credential_type AS credential_type,
        pr.head_repository_default_branch_observation_key AS observation_key,
        pr.head_repository_default_branch_observed_at AS observed_at,
        pr.head_repository_default_branch_event_at AS event_at
      FROM pull_request_detail pr
      WHERE b.current_pull_request_detail_id IS NOT NULL
        AND pr.id = b.current_pull_request_detail_id
        AND pr.branch_artifact_id = a.id
        AND pr.organization_id = a.organization_id
        AND LOWER(pr.head_repository_full_name) = b.repository_full_name
        AND ${pullRequestAuthorityGroupIsPresentSql()}

      UNION ALL

      SELECT
        repository.id,
        repository.github_repo_id,
        LOWER(repository.full_name),
        repository.default_branch_name,
        repository.default_branch_availability,
        repository.default_branch_completeness,
        repository.default_branch_reason,
        repository.default_branch_source,
        repository.default_branch_mechanism,
        repository.default_branch_trigger,
        repository.default_branch_credential_type,
        repository.default_branch_observation_key,
        repository.default_branch_observed_at,
        repository.default_branch_event_at
      FROM github_installation_repositories repository
      INNER JOIN github_installations installation
        ON installation.id = repository.installation_id
      WHERE (
          (b.repository_id IS NOT NULL AND repository.id = b.repository_id)
          OR (
            b.repository_id IS NULL
            AND LOWER(repository.full_name) = b.repository_full_name
          )
        )
        AND repository.removed_at IS NULL
        AND installation.organization_id = a.organization_id
        AND installation.status = ${GitHubInstallationStatus.ACTIVE}::"GitHubInstallationStatus"
        AND ${repositoryAuthorityGroupIsPresentSql("repository")}

      UNION ALL

      SELECT
        NULL::uuid,
        public_repository.github_repo_id,
        LOWER(public_repository.full_name),
        public_repository.default_branch_name,
        public_repository.default_branch_availability,
        public_repository.default_branch_completeness,
        public_repository.default_branch_reason,
        public_repository.default_branch_source,
        public_repository.default_branch_mechanism,
        public_repository.default_branch_trigger,
        public_repository.default_branch_credential_type,
        public_repository.default_branch_observation_key,
        public_repository.default_branch_observed_at,
        public_repository.default_branch_event_at
      FROM public_repositories public_repository
      WHERE public_repository.organization_id = a.organization_id
        AND LOWER(public_repository.full_name) = b.repository_full_name
        AND ${repositoryAuthorityGroupIsPresentSql("public_repository")}
    ),
    authority_order AS (
      SELECT authority.*, COALESCE(authority.event_at, authority.observed_at) AS authority_at
      FROM repository_default_authorities authority
    ),
    latest_authorities AS (
      SELECT authority.*
      FROM authority_order authority
      WHERE authority.authority_at = (
        SELECT MAX(candidate.authority_at)
        FROM authority_order candidate
      )
    ),
    branch_repository AS (
      SELECT repository.github_repo_id
      FROM github_installation_repositories repository
      INNER JOIN github_installations installation
        ON installation.id = repository.installation_id
      WHERE repository.id = b.repository_id
        AND repository.removed_at IS NULL
        AND installation.organization_id = a.organization_id
        AND installation.status = ${GitHubInstallationStatus.ACTIVE}::"GitHubInstallationStatus"
    ),
    current_pull_request_authority AS (
      SELECT pr.id
      FROM pull_request_detail pr
      WHERE pr.id = b.current_pull_request_detail_id
        AND pr.branch_artifact_id = a.id
        AND pr.organization_id = a.organization_id
        AND LOWER(pr.head_repository_full_name) = b.repository_full_name
        AND ${pullRequestAuthorityGroupIsPresentSql()}
    )
    SELECT 1
    FROM latest_authorities latest
    HAVING COUNT(*) > 0
      AND (SELECT COALESCE(BOOL_AND(
        authority.observed_at IS NOT NULL
      ), FALSE) FROM repository_default_authorities authority)
      AND (
        b.current_pull_request_detail_id IS NULL
        OR (SELECT COUNT(*) FROM current_pull_request_authority) = 1
      )
      AND COALESCE(BOOL_AND(latest.provider_repository_id IS NOT NULL), FALSE)
      AND COALESCE(BOOL_AND(BTRIM(latest.provider_repository_id) <> ''), FALSE)
      AND COALESCE(BOOL_AND(COALESCE(
        latest.repository_full_name = b.repository_full_name,
        FALSE
      )), FALSE)
      AND COUNT(DISTINCT latest.provider_repository_id) = 1
      AND COUNT(DISTINCT latest.repository_full_name) = 1
      AND (
        b.repository_id IS NOT NULL
        OR (SELECT COUNT(DISTINCT authority.provider_repository_id)
            FROM repository_default_authorities authority) = 1
      )
      AND (
        b.repository_id IS NULL
        OR (
          (SELECT COUNT(*) FROM branch_repository) = 1
          AND COALESCE(BOOL_AND(COALESCE(
            latest.provider_repository_id = (
              SELECT repository.github_repo_id FROM branch_repository repository
            ),
            FALSE
          )), FALSE)
        )
      )
      AND COALESCE(BOOL_AND(COALESCE(
        latest.availability = ${RepositoryDefaultAvailability.Available},
        FALSE
      )), FALSE)
      AND COALESCE(BOOL_AND(COALESCE(
        latest.completeness = ${RepositoryDefaultCompleteness.Complete},
        FALSE
      )), FALSE)
      AND COALESCE(BOOL_AND(latest.default_branch_name IS NOT NULL), FALSE)
      AND COALESCE(BOOL_AND(BTRIM(latest.default_branch_name) <> ''), FALSE)
      AND COALESCE(BOOL_AND(latest.reason IS NULL), FALSE)
      AND COUNT(DISTINCT latest.default_branch_name) = 1
      AND COALESCE(BOOL_AND(latest.observation_key IS NOT NULL), FALSE)
      AND COALESCE(BOOL_AND(BTRIM(latest.observation_key) <> ''), FALSE)
      AND COALESCE(BOOL_AND(COALESCE(
        latest.source IN (${Prisma.join(knownRepositoryDefaultSources())}),
        FALSE
      )), FALSE)
      AND COALESCE(BOOL_AND(COALESCE(
        latest.mechanism IN (${Prisma.join(knownFetchMechanisms())}),
        FALSE
      )), FALSE)
      AND COALESCE(BOOL_AND(COALESCE(
        latest.trigger IN (${Prisma.join(knownFetchTriggers())}),
        FALSE
      )), FALSE)
      AND COALESCE(BOOL_AND(COALESCE(
        latest.credential_type IN (${Prisma.join(knownCredentialTypes())}),
        FALSE
      )), FALSE)
      AND MAX(latest.default_branch_name) <> b.branch_name
  )`;
}

/** One by-id eligibility snapshot shared by detail and every subresource. */
export async function branchHasCloudEligibility(
  db: CloudBranchEligibilityClient,
  organizationId: string,
  branchId: string
): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT a.id
    FROM artifacts a
    INNER JOIN branch_detail b ON b.artifact_id = a.id
    WHERE a.id = ${branchId}::uuid
      AND a.organization_id = ${organizationId}::uuid
      AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
      AND b.deleted_at IS NULL
      AND ${branchLinkedSessionExistsSql()}
      AND ${cloudBranchEligibilitySql()}
    LIMIT 1
  `);
  return rows.length > 0;
}

function toDatedAuthority(
  authority: NormalizedPersistedRepositoryDefaultAuthority
): LatestAuthority | null {
  const observedAt = Date.parse(authority.provenance?.observedAt ?? "");
  if (!Number.isFinite(observedAt)) {
    return null;
  }
  const eventAt = Date.parse(authority.provenance?.eventAt ?? "");
  return {
    authority,
    eventAt: Number.isFinite(eventAt) ? eventAt : null,
    observedAt,
  };
}

function isLegacyAuthorityAbsence(
  authority: NormalizedPersistedRepositoryDefaultAuthority
): boolean {
  return (
    authority.provenance === undefined &&
    "reason" in authority.evidence &&
    authority.evidence.reason === RepositoryDefaultReason.LegacyRecord
  );
}

function pullRequestAuthorityGroupIsPresentSql(): Prisma.Sql {
  return Prisma.sql`(
    pr.head_repository_default_branch_name IS NOT NULL
    OR pr.head_repository_default_branch_availability IS NOT NULL
    OR pr.head_repository_default_branch_completeness IS NOT NULL
    OR pr.head_repository_default_branch_reason IS NOT NULL
    OR pr.head_repository_default_branch_source IS NOT NULL
    OR pr.head_repository_default_branch_mechanism IS NOT NULL
    OR pr.head_repository_default_branch_trigger IS NOT NULL
    OR pr.head_repository_default_branch_credential_type IS NOT NULL
    OR pr.head_repository_default_branch_credential_owner_id IS NOT NULL
    OR pr.head_repository_default_branch_observation_key IS NOT NULL
    OR pr.head_repository_default_branch_observed_at IS NOT NULL
    OR pr.head_repository_default_branch_event_at IS NOT NULL
  )`;
}

function repositoryAuthorityGroupIsPresentSql(
  owner: "repository" | "public_repository"
): Prisma.Sql {
  if (owner === "repository") {
    return Prisma.sql`(
      repository.default_branch_name IS NOT NULL
      OR repository.default_branch_availability IS NOT NULL
      OR repository.default_branch_completeness IS NOT NULL
      OR repository.default_branch_reason IS NOT NULL
      OR repository.default_branch_source IS NOT NULL
      OR repository.default_branch_mechanism IS NOT NULL
      OR repository.default_branch_trigger IS NOT NULL
      OR repository.default_branch_credential_type IS NOT NULL
      OR repository.default_branch_credential_owner_id IS NOT NULL
      OR repository.default_branch_observation_key IS NOT NULL
      OR repository.default_branch_observed_at IS NOT NULL
      OR repository.default_branch_event_at IS NOT NULL
    )`;
  }
  return Prisma.sql`(
    public_repository.default_branch_name IS NOT NULL
    OR public_repository.default_branch_availability IS NOT NULL
    OR public_repository.default_branch_completeness IS NOT NULL
    OR public_repository.default_branch_reason IS NOT NULL
    OR public_repository.default_branch_source IS NOT NULL
    OR public_repository.default_branch_mechanism IS NOT NULL
    OR public_repository.default_branch_trigger IS NOT NULL
    OR public_repository.default_branch_credential_type IS NOT NULL
    OR public_repository.default_branch_credential_owner_id IS NOT NULL
    OR public_repository.default_branch_observation_key IS NOT NULL
    OR public_repository.default_branch_observed_at IS NOT NULL
    OR public_repository.default_branch_event_at IS NOT NULL
  )`;
}

function isCompleteAvailableAuthority(
  authority: NormalizedPersistedRepositoryDefaultAuthority
): authority is NormalizedPersistedRepositoryDefaultAuthority & {
  evidence: {
    availability: typeof RepositoryDefaultAvailability.Available;
    completeness: typeof RepositoryDefaultCompleteness.Complete;
    defaultBranch: string;
  };
} {
  const provenance = authority.provenance;
  return Boolean(
    authority.repository.providerRepositoryId.trim() &&
      provenance?.observationKey.trim() &&
      provenance.source !== RepositoryDefaultSource.Unknown &&
      provenance.mechanism !== GitHubFetchMechanism.Unknown &&
      provenance.trigger !== GitHubFetchTrigger.Unknown &&
      provenance.credentialType !== GitHubFetchCredentialType.Unknown &&
      authority.evidence.availability ===
        RepositoryDefaultAvailability.Available &&
      authority.evidence.completeness ===
        RepositoryDefaultCompleteness.Complete &&
      "defaultBranch" in authority.evidence &&
      authority.evidence.defaultBranch.trim()
  );
}

function authoritiesAgree(
  expected: NormalizedPersistedRepositoryDefaultAuthority & {
    evidence: { defaultBranch: string };
  },
  candidate: NormalizedPersistedRepositoryDefaultAuthority
): boolean {
  return (
    isCompleteAvailableAuthority(candidate) &&
    candidate.repository.provider === expected.repository.provider &&
    candidate.repository.providerRepositoryId ===
      expected.repository.providerRepositoryId &&
    candidate.repository.fullName === expected.repository.fullName &&
    candidate.evidence.defaultBranch === expected.evidence.defaultBranch
  );
}

function knownRepositoryDefaultSources(): string[] {
  return Object.values(RepositoryDefaultSource).filter(
    (source) => source !== RepositoryDefaultSource.Unknown
  );
}

function knownFetchMechanisms(): string[] {
  return Object.values(GitHubFetchMechanism).filter(
    (mechanism) => mechanism !== GitHubFetchMechanism.Unknown
  );
}

function knownFetchTriggers(): string[] {
  return Object.values(GitHubFetchTrigger).filter(
    (trigger) => trigger !== GitHubFetchTrigger.Unknown
  );
}

function knownCredentialTypes(): string[] {
  return Object.values(GitHubFetchCredentialType).filter(
    (credentialType) => credentialType !== GitHubFetchCredentialType.Unknown
  );
}
