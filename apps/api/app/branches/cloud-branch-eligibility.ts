import { BranchPushSource } from "@repo/api/src/types/artifact";
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
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";
import { branchProductWroteExistsSql } from "./branch-contribution-sql";
import { normalizedRepositoryFullNameSql } from "./branch-repository-name-sql";

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
 *
 * "Twin" is a contract, not a description: this CTE's arms must be the same SET
 * of authority sources the pure function is fed by `readLockedAuthorityRows`.
 * PLN-1775 M4 added the observed-repository source to the write side only, and
 * an installation-free org — whose verified observation is its ONLY authority —
 * got a `branch_detail` row that every Product surface then filtered out, since
 * this predicate gates the Branches read, the metric denominator, trace
 * comments and the project tree (#5551). A source added to one side and not the
 * other does not degrade; it makes the two halves disagree about whether a
 * branch exists.
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

      UNION ALL

      SELECT
        NULL::uuid,
        observed_repository.github_repo_id,
        observed_repository.repository_full_name,
        observed_repository.default_branch_name,
        observed_repository.default_branch_availability,
        observed_repository.default_branch_completeness,
        observed_repository.default_branch_reason,
        observed_repository.default_branch_source,
        observed_repository.default_branch_mechanism,
        observed_repository.default_branch_trigger,
        observed_repository.default_branch_credential_type,
        observed_repository.default_branch_observation_key,
        observed_repository.default_branch_observed_at,
        observed_repository.default_branch_event_at
      FROM github_observed_repository observed_repository
      WHERE observed_repository.organization_id = a.organization_id
        -- Equality, not LOWER(): normalizeRepoFullName is the only writer of
        -- this column, so it already holds the form b.repository_full_name is
        -- in, and equality is what lets the (organization_id,
        -- repository_full_name) unique serve the lookup. Same choice the write
        -- twin makes in authority-source-queries.ts.
        AND observed_repository.repository_full_name = b.repository_full_name
        AND observed_repository.verification_state = ${GitHubObservedRepositoryVerificationState.Verified}
        AND observed_repository.github_repo_id IS NOT NULL
        AND ${repositoryAuthorityGroupIsPresentSql("observed_repository")}
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
    ),
    -- ISS-8422: group PRESENCE alone, with no identity test, so "never
    -- observed" can be told apart from "observed, and it names another
    -- repository". The desktop lane writes a row holding nothing but the
    -- server-derived html_url the moment a PR is opened, and the single CTE
    -- above could not distinguish that from the mismatch ISS-5827 aimed at.
    --
    -- READ-SIDE ONLY, and deliberately outside the twin contract documented on
    -- cloudBranchEligibilitySql: isCloudBranchEligible is never handed a
    -- "current PR" concept, and the write-side authority query in
    -- authority-source-queries.ts has no branch_artifact_id or current-pointer
    -- notion at all. There is nothing on that side to keep in parity with, so
    -- do not "restore parity" by inventing one.
    current_pull_request_observed_authority AS (
      SELECT pr.id
      FROM pull_request_detail pr
      WHERE pr.id = b.current_pull_request_detail_id
        AND pr.organization_id = a.organization_id
        AND ${pullRequestAuthorityGroupIsPresentSql()}
    ),
    -- ISS-8422: the current pointer resolves to a row that belongs to THIS
    -- branch. A pointer-resolves test, not an authority test — kept separate so
    -- it is not folded back into the authority CTEs. Before the split above, a
    -- pointer at a factless row belonging to ANOTHER branch failed closed only
    -- as a side effect of the identity and presence tests sharing one CTE;
    -- without this conjunct the split would newly admit it.
    current_pull_request_pointer AS (
      SELECT pr.id
      FROM pull_request_detail pr
      WHERE pr.id = b.current_pull_request_detail_id
        AND pr.branch_artifact_id = a.id
        AND pr.organization_id = a.organization_id
    ),
    -- ISS-8422: the current PR names a head repository that CONTRADICTS the
    -- branch's own.
    --
    -- Head identity is provider evidence in its own right, so the A2 fallback
    -- below must not call a row carrying it "never observed". A PR opened from
    -- a fork has a foreign head_repository_full_name and an empty authority
    -- group; admitting it would let the branch take its default-branch answer
    -- from the BASE repository, which is the head-identity substitution
    -- ISS-5827 / PRD-600 COMMON-002 exists to refuse. Such a row fails closed
    -- exactly as it did before the split (davetho review on #6313).
    --
    -- Identity that AGREES with the branch is not evidence of anything to
    -- refuse, so it does not appear here: gating the fallback on presence
    -- rather than contradiction would newly hide every branch whose PR names
    -- its own repository. A populated head github id with no resolvable branch
    -- repository to compare against counts as contradicting — unmatchable
    -- identity fails closed, as it did before this arm existed.
    current_pull_request_foreign_head_identity AS (
      SELECT pr.id
      FROM pull_request_detail pr
      WHERE pr.id = b.current_pull_request_detail_id
        AND pr.organization_id = a.organization_id
        AND (
          (
            pr.head_repository_full_name IS NOT NULL
            AND LOWER(pr.head_repository_full_name) <> b.repository_full_name
          )
          OR (
            pr.head_repository_github_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM branch_repository repository
              WHERE repository.github_repo_id = pr.head_repository_github_id
            )
          )
        )
    )
    SELECT 1
    FROM latest_authorities latest
    HAVING COUNT(*) > 0
      AND (SELECT COALESCE(BOOL_AND(
        authority.observed_at IS NOT NULL
      ), FALSE) FROM repository_default_authorities authority)
      AND (
        b.current_pull_request_detail_id IS NULL
        OR (SELECT COUNT(*) FROM current_pull_request_pointer) = 1
      )
      AND (
        b.current_pull_request_detail_id IS NULL
        -- ISS-8422 A2: a current PR that observed NOTHING is treated as no
        -- observed PR for membership. The branch appears; the PR still supplies
        -- no authority and still states nothing. "Nothing" covers BOTH halves —
        -- no authority group AND no contradicting head identity — or the arm
        -- would admit the fork PR ISS-5827 refuses.
        OR (
          (SELECT COUNT(*) FROM current_pull_request_observed_authority) = 0
          AND (SELECT COUNT(*) FROM current_pull_request_foreign_head_identity) = 0
        )
        -- ISS-5827 / PRD-600 COMMON-002, unchanged: a PR that DOES carry
        -- head-repository authority must match the branch's repository
        -- identity, so that missing evidence can never imply the base repo.
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

/**
 * Shared Product Branch gate. Both candidate and by-id reads call this exact
 * composition so publication, Wrote, repository authority, and default-Branch
 * behavior cannot drift across Product surfaces.
 */
export function cloudBranchProductEligibilitySql(): Prisma.Sql {
  return Prisma.sql`(
    ${branchProductWroteExistsSql()}
    AND ${verifiedBranchPublicationSql()}
    AND ${cloudBranchEligibilitySql()}
  )`;
}

/**
 * Metric-denominator authority. ISS-8148 (PRD-683 Ruling 2 + D7, Kerensa ruling
 * 2026-08-26: D7 supersedes PRD-600 COMMON-023 for the no-push-evidence
 * population): a Branch without verified publication no longer counts in ANY
 * metric denominator — the session write gate stops new local-only rows from
 * materializing, and a legacy no-evidence row is excluded (never deleted) so
 * it heals into every population when push evidence arrives. Until ISS-8148
 * this composition deliberately admitted pre-publication rows (COMMON-023's
 * "session cost remains eligible before a push/PR"). The composition is now
 * identical to `cloudBranchProductEligibilitySql`; the two names stay
 * separate so the surfaces can diverge again deliberately, never by drift.
 */
export function cloudBranchMetricDenominatorEligibilitySql(): Prisma.Sql {
  return cloudBranchProductEligibilitySql();
}

/** Verified publication through a successful push or provider-bound PR head. */
export function verifiedBranchPublicationSql(): Prisma.Sql {
  return Prisma.sql`(
    (
      b.first_pushed_at IS NOT NULL
      AND isfinite(b.first_pushed_at)
      AND b.push_source IN (${Prisma.join([...VERIFIED_BRANCH_PUSH_SOURCES])})
    )
    OR EXISTS (
      SELECT 1
      FROM pull_request_detail published_pr
      WHERE published_pr.organization_id = a.organization_id
        AND published_pr.branch_artifact_id = a.id
        AND published_pr.head_ref_oid IS NOT NULL
        AND published_pr.head_ref_oid ~ '^[0-9a-fA-F]{40}$'
        AND published_pr.head_ref_name IS NOT NULL
        AND btrim(published_pr.head_ref_name) = b.branch_name
        AND published_pr.head_repository_github_id IS NOT NULL
        AND btrim(published_pr.head_repository_github_id) <> ''
        AND published_pr.head_repository_full_name IS NOT NULL
        AND ${normalizedRepositoryFullNameSql(Prisma.sql`published_pr.head_repository_full_name`)}
          = ${normalizedRepositoryFullNameSql(Prisma.sql`b.repository_full_name`)}
        AND published_pr.head_repository_default_branch_availability = ${RepositoryDefaultAvailability.Available}
        AND published_pr.head_repository_default_branch_completeness = ${RepositoryDefaultCompleteness.Complete}
        AND published_pr.head_repository_default_branch_name IS NOT NULL
        AND btrim(published_pr.head_repository_default_branch_name) <> ''
        AND published_pr.head_repository_default_branch_name <> b.branch_name
        AND published_pr.head_repository_default_branch_reason IS NULL
        AND published_pr.head_repository_default_branch_source IN (${Prisma.join(knownRepositoryDefaultSources())})
        AND published_pr.head_repository_default_branch_mechanism IN (${Prisma.join(knownFetchMechanisms())})
        AND published_pr.head_repository_default_branch_trigger IN (${Prisma.join(knownFetchTriggers())})
        AND published_pr.head_repository_default_branch_credential_type IN (${Prisma.join(knownCredentialTypes())})
        AND published_pr.head_repository_default_branch_observation_key IS NOT NULL
        AND btrim(published_pr.head_repository_default_branch_observation_key) <> ''
        AND published_pr.head_repository_default_branch_observed_at IS NOT NULL
        AND isfinite(published_pr.head_repository_default_branch_observed_at)
        AND (
          b.repository_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM github_installation_repositories publication_repository
            INNER JOIN github_installations publication_installation
              ON publication_installation.id = publication_repository.installation_id
            WHERE publication_repository.id = b.repository_id
              AND publication_repository.removed_at IS NULL
              AND publication_installation.organization_id = a.organization_id
              AND publication_installation.status = ${GitHubInstallationStatus.ACTIVE}::"GitHubInstallationStatus"
              AND publication_repository.github_repo_id = published_pr.head_repository_github_id
          )
        )
    )
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
      AND ${cloudBranchProductEligibilitySql()}
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

export function pullRequestAuthorityGroupIsPresentSql(): Prisma.Sql {
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

export function repositoryAuthorityGroupIsPresentSql(
  owner: "repository" | "public_repository" | "observed_repository"
): Prisma.Sql {
  if (owner === "observed_repository") {
    return Prisma.sql`(
      observed_repository.default_branch_name IS NOT NULL
      OR observed_repository.default_branch_availability IS NOT NULL
      OR observed_repository.default_branch_completeness IS NOT NULL
      OR observed_repository.default_branch_reason IS NOT NULL
      OR observed_repository.default_branch_source IS NOT NULL
      OR observed_repository.default_branch_mechanism IS NOT NULL
      OR observed_repository.default_branch_trigger IS NOT NULL
      OR observed_repository.default_branch_credential_type IS NOT NULL
      OR observed_repository.default_branch_credential_owner_id IS NOT NULL
      OR observed_repository.default_branch_observation_key IS NOT NULL
      OR observed_repository.default_branch_observed_at IS NOT NULL
      OR observed_repository.default_branch_event_at IS NOT NULL
    )`;
  }
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

export function knownRepositoryDefaultSources(): string[] {
  return Object.values(RepositoryDefaultSource).filter(
    (source) => source !== RepositoryDefaultSource.Unknown
  );
}

export function knownFetchMechanisms(): string[] {
  return Object.values(GitHubFetchMechanism).filter(
    (mechanism) => mechanism !== GitHubFetchMechanism.Unknown
  );
}

export function knownFetchTriggers(): string[] {
  return Object.values(GitHubFetchTrigger).filter(
    (trigger) => trigger !== GitHubFetchTrigger.Unknown
  );
}

export function knownCredentialTypes(): string[] {
  return Object.values(GitHubFetchCredentialType).filter(
    (credentialType) => credentialType !== GitHubFetchCredentialType.Unknown
  );
}

/**
 * Which `BranchPushSource` values count as VERIFIED push evidence. Exhaustive
 * over the enum so a new source fails `tsc` until it is deliberately mapped;
 * the derived list feeds both the raw-SQL predicate here
 * (`verifiedBranchPublicationSql`) and the Prisma-shape
 * `branchPushEvidenceWhere`, so the two cannot drift (ISS-8148 review).
 */
const BRANCH_PUSH_SOURCE_IS_VERIFIED: Record<BranchPushSource, boolean> = {
  [BranchPushSource.Session]: true,
  [BranchPushSource.Webhook]: true,
};

export const VERIFIED_BRANCH_PUSH_SOURCES: readonly BranchPushSource[] =
  Object.values(BranchPushSource).filter(
    (source) => BRANCH_PUSH_SOURCE_IS_VERIFIED[source]
  );
