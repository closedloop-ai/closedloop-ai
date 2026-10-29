import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
} from "@repo/api/src/types/repository-default-identity";
import { ArtifactType, GitHubInstallationStatus, Prisma } from "@repo/database";
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";
import { branchProductWroteExistsSql } from "./branch-contribution-sql";
import {
  knownCredentialTypes,
  knownFetchMechanisms,
  knownFetchTriggers,
  knownRepositoryDefaultSources,
  pullRequestAuthorityGroupIsPresentSql,
  repositoryAuthorityGroupIsPresentSql,
  verifiedBranchPublicationSql,
} from "./cloud-branch-eligibility";

/**
 * The Branches whose repository default-branch authority admits them, for one
 * organization, in one set-based pass (ISS-11589).
 *
 * This is `cloudBranchEligibilitySql`'s decision, computed for every Branch at
 * once. The correlated form rebuilt the same four-source authority list inside
 * an EXISTS for each Branch row, about 8,000 times per read for an organization
 * with five repositories. Here the (Branch, authority) pairs come from hash
 * joins against those few repository rows, the newest authority per Branch is
 * picked with a window, and the same conditions are applied as aggregates.
 *
 * The conditions and the way NULL is treated are the correlated form's own, one
 * for one: it stays the oracle in the differential test until it is retired.
 * `branchIds` limits the pass for by-id callers.
 */
export function cloudBranchAuthorityEligibleIdsSql(
  organizationId: string,
  branchIds?: readonly string[]
): Prisma.Sql {
  const restriction =
    branchIds === undefined
      ? Prisma.empty
      : Prisma.sql`AND a.id = ANY(${[...branchIds]}::uuid[])`;
  return Prisma.sql`
    WITH branch_scope AS MATERIALIZED (
      SELECT
        a.id AS branch_id,
        a.organization_id,
        b.repository_id,
        b.repository_full_name,
        b.branch_name,
        b.current_pull_request_detail_id AS current_pr_id,
        CASE WHEN branch_installation.id IS NOT NULL
          THEN branch_repository.github_repo_id
        END AS branch_provider_id,
        (pr.branch_artifact_id = a.id) AS is_pointer,
        ${pullRequestAuthorityGroupIsPresentSql()} AS has_authority_group,
        (
          (
            pr.head_repository_full_name IS NOT NULL
            AND LOWER(pr.head_repository_full_name) <> b.repository_full_name
          )
          OR (
            pr.head_repository_github_id IS NOT NULL
            AND NOT COALESCE(
              CASE WHEN branch_installation.id IS NOT NULL
                THEN branch_repository.github_repo_id
              END = pr.head_repository_github_id,
              FALSE
            )
          )
        ) AS has_foreign_head,
        (
          pr.branch_artifact_id = a.id
          AND LOWER(pr.head_repository_full_name) = b.repository_full_name
          AND ${pullRequestAuthorityGroupIsPresentSql()}
        ) AS matches_authority
      FROM artifacts a
      INNER JOIN branch_detail b ON b.artifact_id = a.id
      LEFT JOIN pull_request_detail pr
        ON pr.id = b.current_pull_request_detail_id
        AND pr.organization_id = a.organization_id
      LEFT JOIN github_installation_repositories branch_repository
        ON branch_repository.id = b.repository_id
        AND branch_repository.removed_at IS NULL
      LEFT JOIN github_installations branch_installation
        ON branch_installation.id = branch_repository.installation_id
        AND branch_installation.organization_id = a.organization_id
        AND branch_installation.status = ${GitHubInstallationStatus.ACTIVE}::"GitHubInstallationStatus"
      WHERE a.organization_id = ${organizationId}::uuid
        AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
        ${restriction}
    ),
    authority AS MATERIALIZED (
      SELECT
        scope.branch_id,
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
        pr.head_repository_default_branch_event_at AS event_at,
        ${scopeColumns()}
      FROM branch_scope scope
      INNER JOIN pull_request_detail pr
        ON pr.id = scope.current_pr_id
        AND pr.branch_artifact_id = scope.branch_id
        AND pr.organization_id = scope.organization_id
        AND LOWER(pr.head_repository_full_name) = scope.repository_full_name
      WHERE scope.current_pr_id IS NOT NULL
        AND ${pullRequestAuthorityGroupIsPresentSql()}

      UNION ALL

      SELECT
        scope.branch_id,
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
        repository.default_branch_event_at,
        ${scopeColumns()}
      FROM branch_scope scope
      INNER JOIN github_installation_repositories repository
        ON repository.id = scope.repository_id
      INNER JOIN github_installations installation
        ON installation.id = repository.installation_id
      WHERE scope.repository_id IS NOT NULL
        AND repository.removed_at IS NULL
        AND installation.organization_id = scope.organization_id
        AND installation.status = ${GitHubInstallationStatus.ACTIVE}::"GitHubInstallationStatus"
        AND ${repositoryAuthorityGroupIsPresentSql("repository")}

      UNION ALL

      SELECT
        scope.branch_id,
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
        repository.default_branch_event_at,
        ${scopeColumns()}
      FROM branch_scope scope
      INNER JOIN github_installation_repositories repository
        ON LOWER(repository.full_name) = scope.repository_full_name
      INNER JOIN github_installations installation
        ON installation.id = repository.installation_id
      WHERE scope.repository_id IS NULL
        AND repository.removed_at IS NULL
        AND installation.organization_id = scope.organization_id
        AND installation.status = ${GitHubInstallationStatus.ACTIVE}::"GitHubInstallationStatus"
        AND ${repositoryAuthorityGroupIsPresentSql("repository")}

      UNION ALL

      SELECT
        scope.branch_id,
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
        public_repository.default_branch_event_at,
        ${scopeColumns()}
      FROM branch_scope scope
      INNER JOIN public_repositories public_repository
        ON public_repository.organization_id = scope.organization_id
        AND LOWER(public_repository.full_name) = scope.repository_full_name
      WHERE ${repositoryAuthorityGroupIsPresentSql("public_repository")}

      UNION ALL

      SELECT
        scope.branch_id,
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
        observed_repository.default_branch_event_at,
        ${scopeColumns()}
      FROM branch_scope scope
      INNER JOIN github_observed_repository observed_repository
        ON observed_repository.organization_id = scope.organization_id
        AND observed_repository.repository_full_name = scope.repository_full_name
      WHERE observed_repository.verification_state = ${GitHubObservedRepositoryVerificationState.Verified}
        AND observed_repository.github_repo_id IS NOT NULL
        AND ${repositoryAuthorityGroupIsPresentSql("observed_repository")}
    ),
    facts AS MATERIALIZED (
      SELECT
        ordered.branch_id,
        COUNT(*) FILTER (WHERE ordered.authority_at = ordered.newest_authority_at) AS latest_rows,
        COALESCE(BOOL_AND(ordered.observed_at IS NOT NULL), FALSE) AS all_observed,
        COUNT(DISTINCT ordered.provider_repository_id) AS distinct_provider_ids,
        BOOL_AND(ordered.provider_repository_id IS NOT NULL) FILTER (WHERE latest) AS provider_present,
        BOOL_AND(BTRIM(ordered.provider_repository_id) <> '') FILTER (WHERE latest) AS provider_nonblank,
        COUNT(DISTINCT ordered.provider_repository_id) FILTER (WHERE latest) AS provider_count,
        MIN(ordered.provider_repository_id) FILTER (WHERE latest) AS provider_id,
        BOOL_AND(ordered.repository_full_name IS NOT NULL) FILTER (WHERE latest) AS name_present,
        COUNT(DISTINCT ordered.repository_full_name) FILTER (WHERE latest) AS name_count,
        MIN(ordered.repository_full_name) FILTER (WHERE latest) AS repository_name,
        BOOL_AND(COALESCE(
          ordered.availability = ${RepositoryDefaultAvailability.Available},
          FALSE
        )) FILTER (WHERE latest) AS available,
        BOOL_AND(COALESCE(
          ordered.completeness = ${RepositoryDefaultCompleteness.Complete},
          FALSE
        )) FILTER (WHERE latest) AS complete,
        BOOL_AND(ordered.default_branch_name IS NOT NULL) FILTER (WHERE latest) AS default_present,
        BOOL_AND(BTRIM(ordered.default_branch_name) <> '') FILTER (WHERE latest) AS default_nonblank,
        BOOL_AND(ordered.reason IS NULL) FILTER (WHERE latest) AS reason_absent,
        COUNT(DISTINCT ordered.default_branch_name) FILTER (WHERE latest) AS default_count,
        MAX(ordered.default_branch_name) FILTER (WHERE latest) AS default_branch_name,
        BOOL_AND(ordered.observation_key IS NOT NULL) FILTER (WHERE latest) AS key_present,
        BOOL_AND(BTRIM(ordered.observation_key) <> '') FILTER (WHERE latest) AS key_nonblank,
        BOOL_AND(COALESCE(
          ordered.source IN (${Prisma.join(knownRepositoryDefaultSources())}),
          FALSE
        )) FILTER (WHERE latest) AS source_known,
        BOOL_AND(COALESCE(
          ordered.mechanism IN (${Prisma.join(knownFetchMechanisms())}),
          FALSE
        )) FILTER (WHERE latest) AS mechanism_known,
        BOOL_AND(COALESCE(
          ordered.trigger IN (${Prisma.join(knownFetchTriggers())}),
          FALSE
        )) FILTER (WHERE latest) AS trigger_known,
        BOOL_AND(COALESCE(
          ordered.credential_type IN (${Prisma.join(knownCredentialTypes())}),
          FALSE
        )) FILTER (WHERE latest) AS credential_known,
        BOOL_AND(ordered.repo_unlinked) AS repo_unlinked,
        BOOL_AND(ordered.no_current_pr) AS no_current_pr,
        MIN(ordered.scope_repository_name) AS scope_repository_name,
        MIN(ordered.scope_branch_name) AS scope_branch_name,
        MIN(ordered.scope_provider_id) AS scope_provider_id,
        BOOL_AND(COALESCE(ordered.is_pointer, FALSE)) AS is_pointer,
        BOOL_AND(COALESCE(ordered.has_authority_group, FALSE)) AS has_authority_group,
        BOOL_AND(COALESCE(ordered.has_foreign_head, FALSE)) AS has_foreign_head,
        BOOL_AND(COALESCE(ordered.matches_authority, FALSE)) AS matches_authority
      FROM (
        SELECT
          authority.*,
          (
            COALESCE(authority.event_at, authority.observed_at)
              = MAX(COALESCE(authority.event_at, authority.observed_at))
                OVER (PARTITION BY authority.branch_id)
          ) AS latest,
          COALESCE(authority.event_at, authority.observed_at) AS authority_at,
          MAX(COALESCE(authority.event_at, authority.observed_at))
            OVER (PARTITION BY authority.branch_id) AS newest_authority_at
        FROM authority
      ) ordered
      GROUP BY ordered.branch_id
    )
    SELECT facts.branch_id
    FROM facts
    WHERE facts.latest_rows > 0
      AND facts.all_observed
      AND (facts.no_current_pr OR facts.is_pointer)
      AND (
        facts.no_current_pr
        OR (NOT facts.has_authority_group AND NOT facts.has_foreign_head)
        OR facts.matches_authority
      )
      AND COALESCE(facts.provider_present, FALSE)
      AND COALESCE(facts.provider_nonblank, FALSE)
      AND COALESCE(facts.name_present, FALSE)
      AND COALESCE(facts.repository_name = facts.scope_repository_name, FALSE)
      AND facts.provider_count = 1
      AND facts.name_count = 1
      AND (NOT facts.repo_unlinked OR facts.distinct_provider_ids = 1)
      AND (
        facts.repo_unlinked
        OR COALESCE(facts.provider_id = facts.scope_provider_id, FALSE)
      )
      AND facts.available
      AND facts.complete
      AND COALESCE(facts.default_present, FALSE)
      AND COALESCE(facts.default_nonblank, FALSE)
      AND COALESCE(facts.reason_absent, FALSE)
      AND facts.default_count = 1
      AND COALESCE(facts.key_present, FALSE)
      AND COALESCE(facts.key_nonblank, FALSE)
      AND facts.source_known
      AND facts.mechanism_known
      AND facts.trigger_known
      AND facts.credential_known
      AND facts.default_branch_name <> facts.scope_branch_name
  `;
}

/** The per-Branch columns every authority arm repeats, so no later join is needed to read them. */
function scopeColumns(): Prisma.Sql {
  return Prisma.sql`
        (scope.repository_id IS NULL) AS repo_unlinked,
        (scope.current_pr_id IS NULL) AS no_current_pr,
        scope.repository_full_name AS scope_repository_name,
        scope.branch_name AS scope_branch_name,
        scope.branch_provider_id AS scope_provider_id,
        scope.is_pointer,
        scope.has_authority_group,
        scope.has_foreign_head,
        scope.matches_authority`;
}

/**
 * `cloudBranchProductEligibilitySql` for a read over an organization's
 * Branches, with the authority decision taken from one set-based pass instead
 * of a correlated EXISTS per row. Reads `a` and `b` from the enclosing query.
 */
export function cloudBranchProductEligibilitySetSql(
  organizationId: string,
  branchIds?: readonly string[]
): Prisma.Sql {
  return Prisma.sql`(
    ${branchProductWroteExistsSql()}
    AND ${verifiedBranchPublicationSql()}
    AND a.id IN (
      SELECT eligible.branch_id
      FROM (${cloudBranchAuthorityEligibleIdsSql(organizationId, branchIds)}) eligible
    )
  )`;
}

/** Set-based twin of `cloudBranchMetricDenominatorEligibilitySql`, which is the Product gate. */
export function cloudBranchMetricDenominatorEligibilitySetSql(
  organizationId: string,
  branchIds?: readonly string[]
): Prisma.Sql {
  return cloudBranchProductEligibilitySetSql(organizationId, branchIds);
}
