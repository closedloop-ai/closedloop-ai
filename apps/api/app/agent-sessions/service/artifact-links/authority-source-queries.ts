import { GitHubInstallationStatus, Prisma } from "@repo/database";
import { chunksOf } from "@/lib/chunks-of";
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";
import type { AgentSessionUpsertTx } from "../records";

/**
 * The locked reads behind `resolveSessionRepositoryIdentity`, split out of `shared.ts` so
 * that file keeps the RECONCILIATION of repository authority and this one keeps
 * where the rows come from. Four sources answer the same question — what does
 * the server itself know about this repository — and they only differ in which
 * table holds the answer, so they belong together and away from the precedence
 * rules that judge them.
 */

/**
 * Names per `IN (...)` list. Bounds one statement's parameter count on a path
 * that runs inside the sync write transaction.
 */
export const REPOSITORY_NAME_QUERY_CHUNK_SIZE = 100;

export type SessionRepositoryAuthorityRow = {
  id: string;
  githubRepoId: string | null;
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

export type SessionAuthoritySourceRow = {
  repository: SessionRepositoryAuthorityRow;
  repositoryId: string | null;
  source: RepositoryIdentitySource;
};

/** Repository identity with no default-branch authority columns. */
export type SessionRepositoryIdentityRow = {
  /**
   * The installation row's id. Only that source carries one, so every other
   * identity source leaves it null and contributes `githubRepoId` alone.
   */
  repositoryId: string | null;
  githubRepoId: string | null;
  fullName: string;
  /**
   * Which table answered. Two of the four sources are records of a repository
   * the organization can reach for itself and two are not, and `githubRepoId`
   * alone cannot tell them apart — see `serverRepositoryFetchAuthority`.
   */
  source: RepositoryIdentitySource;
};

/**
 * Whether the server holds ANY identity of its own for these names, without the
 * default-branch authority columns `readLockedAuthorityRows` also reads.
 *
 * ISS-9181: this was the installation lookup ALONE, which was sound while an
 * unanswered name only cost a retry. It now decides an acknowledgement that
 * discards the desktop's evidence for good, so it has to ask every source that
 * can hold an identity — an organization reaching a repository through a public
 * row, a PR head, or a verified observation holds identity for it with no
 * active installation anywhere.
 *
 * The other three sources are read only for the names the installation lookup
 * left unanswered, so an installed repository still costs exactly one statement
 * per chunk.
 *
 * The PR-head arm's per-name cost is NOT the whole-history filter #5103
 * recorded: ISS-6452 (migration `20260815120000`) added
 * `pull_request_detail_org_lower_head_repo_full_name_idx` on
 * `(organization_id, lower(head_repository_full_name))
 * WHERE head_repository_full_name IS NOT NULL`, and the arm below queries
 * exactly that predicate. The migration's own EXPLAIN records the arm moving
 * from "Rows Removed by Filter" over the org's PR partition to an Index Cond
 * carrying both columns, so the cost is O(names requested).
 */
export async function readLockedIdentityRows(
  tx: Pick<AgentSessionUpsertTx, "$queryRaw">,
  organizationId: string,
  normalizedNames: readonly string[]
): Promise<SessionRepositoryIdentityRow[]> {
  const rows = await readLockedInstallationIdentityRows(
    tx,
    organizationId,
    normalizedNames
  );
  const answered = new Set(rows.map((row) => row.fullName.toLowerCase()));
  const unanswered = normalizedNames.filter((name) => !answered.has(name));
  if (unanswered.length === 0) {
    return rows;
  }
  rows.push(
    ...(await readNonInstallationIdentityRows(tx, organizationId, unanswered))
  );
  return rows;
}

async function readLockedInstallationIdentityRows(
  tx: Pick<AgentSessionUpsertTx, "$queryRaw">,
  organizationId: string,
  normalizedNames: readonly string[]
): Promise<SessionRepositoryIdentityRow[]> {
  const rows: SessionRepositoryIdentityRow[] = [];
  for (const nameChunk of chunksOf(
    normalizedNames,
    REPOSITORY_NAME_QUERY_CHUNK_SIZE
  )) {
    const names = Prisma.join(nameChunk);
    const chunkRows = await tx.$queryRaw<SessionRepositoryIdentityColumns[]>(
      Prisma.sql`
        SELECT
          repository.id AS "repositoryId",
          repository.github_repo_id AS "githubRepoId",
          repository.full_name AS "fullName"
        FROM github_installation_repositories repository
        INNER JOIN github_installations installation
          ON installation.id = repository.installation_id
        WHERE installation.organization_id = ${organizationId}
          AND installation.status = ${GitHubInstallationStatus.ACTIVE}::"GitHubInstallationStatus"
          AND repository.removed_at IS NULL
          AND LOWER(repository.full_name) IN (${names})
        FOR SHARE OF repository, installation
      `
    );
    rows.push(
      ...chunkRows.map((row) => ({
        ...row,
        source: RepositoryIdentitySource.Installation,
      }))
    );
  }
  return rows;
}

/**
 * The three identity sources that carry no `repositoryId`, read only for the
 * names no installation row answered.
 *
 * `DISTINCT` and no `FOR SHARE`, unlike the installation read above: none of
 * these ids is written back as a foreign key, and a share lock cannot stop the
 * only change that would matter here — a row appearing AFTER the read, which no
 * lock Postgres offers prevents. A row vanishing under the read can only turn a
 * held identity into none, and holding is already the answer that keeps the
 * evidence. The PR-head arm would otherwise return one row per pull request on
 * the repository, so it is deduplicated in the database rather than in memory.
 */
async function readNonInstallationIdentityRows(
  tx: Pick<AgentSessionUpsertTx, "$queryRaw">,
  organizationId: string,
  normalizedNames: readonly string[]
): Promise<SessionRepositoryIdentityRow[]> {
  const rows: SessionRepositoryIdentityRow[] = [];
  for (const nameChunk of chunksOf(
    normalizedNames,
    REPOSITORY_NAME_QUERY_CHUNK_SIZE
  )) {
    const names = Prisma.join(nameChunk);
    const [publicChunk, pullRequestChunk, observedChunk] = await Promise.all([
      tx.$queryRaw<SessionRepositoryIdentityColumns[]>(Prisma.sql`
        SELECT DISTINCT
          NULL::text AS "repositoryId",
          repository.github_repo_id AS "githubRepoId",
          repository.full_name AS "fullName"
        FROM public_repositories repository
        WHERE repository.organization_id = ${organizationId}
          AND LOWER(repository.full_name) IN (${names})
      `),
      tx.$queryRaw<SessionRepositoryIdentityColumns[]>(Prisma.sql`
        SELECT DISTINCT
          NULL::text AS "repositoryId",
          pull_request.head_repository_github_id AS "githubRepoId",
          pull_request.head_repository_full_name AS "fullName"
        FROM pull_request_detail pull_request
        WHERE pull_request.organization_id = ${organizationId}
          AND LOWER(pull_request.head_repository_full_name) IN (${names})
          AND pull_request.head_repository_github_id IS NOT NULL
      `),
      tx.$queryRaw<SessionRepositoryIdentityColumns[]>(Prisma.sql`
        SELECT DISTINCT
          NULL::text AS "repositoryId",
          repository.github_repo_id AS "githubRepoId",
          repository.repository_full_name AS "fullName"
        FROM github_observed_repository repository
        WHERE repository.organization_id = ${organizationId}
          AND repository.repository_full_name IN (${names})
          AND repository.verification_state = ${GitHubObservedRepositoryVerificationState.Verified}
          AND repository.github_repo_id IS NOT NULL
      `),
    ]);
    rows.push(
      ...publicChunk.map((row) => ({
        ...row,
        source: RepositoryIdentitySource.Public,
      })),
      ...pullRequestChunk.map((row) => ({
        ...row,
        source: RepositoryIdentitySource.PullRequestHead,
      })),
      ...observedChunk.map((row) => ({
        ...row,
        source: RepositoryIdentitySource.Observed,
      }))
    );
  }
  return rows;
}

export async function readLockedAuthorityRows(
  tx: Pick<AgentSessionUpsertTx, "$queryRaw">,
  organizationId: string,
  normalizedNames: readonly string[]
): Promise<SessionAuthoritySourceRow[]> {
  const installationRepositories: SessionRepositoryAuthorityRow[] = [];
  const publicRepositories: SessionRepositoryAuthorityRow[] = [];
  const pullRequestRepositories: SessionRepositoryAuthorityRow[] = [];
  const observedRepositories: SessionRepositoryAuthorityRow[] = [];
  for (const nameChunk of chunksOf(
    normalizedNames,
    REPOSITORY_NAME_QUERY_CHUNK_SIZE
  )) {
    const names = Prisma.join(nameChunk);
    const [installedChunk, publicChunk, pullRequestChunk, observedChunk] =
      await Promise.all([
        tx.$queryRaw<SessionRepositoryAuthorityRow[]>(Prisma.sql`
        SELECT
          repository.id,
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
        FROM github_installation_repositories repository
        INNER JOIN github_installations installation
          ON installation.id = repository.installation_id
        WHERE installation.organization_id = ${organizationId}
          AND installation.status = ${GitHubInstallationStatus.ACTIVE}::"GitHubInstallationStatus"
          AND repository.removed_at IS NULL
          AND LOWER(repository.full_name) IN (${names})
        FOR SHARE OF repository, installation
      `),
        tx.$queryRaw<SessionRepositoryAuthorityRow[]>(Prisma.sql`
        SELECT
          repository.id,
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
        FROM public_repositories repository
        WHERE repository.organization_id = ${organizationId}
          AND LOWER(repository.full_name) IN (${names})
        FOR SHARE OF repository
      `),
        tx.$queryRaw<SessionRepositoryAuthorityRow[]>(Prisma.sql`
        WITH candidate_authorities AS (
          SELECT
            pull_request.id,
            COALESCE(
              pull_request.head_repository_default_branch_event_at,
              pull_request.head_repository_default_branch_observed_at
            ) AS authority_at,
            MAX(COALESCE(
              pull_request.head_repository_default_branch_event_at,
              pull_request.head_repository_default_branch_observed_at
            )) OVER (
              PARTITION BY LOWER(pull_request.head_repository_full_name)
            ) AS latest_authority_at
          FROM pull_request_detail pull_request
          WHERE pull_request.organization_id = ${organizationId}
            AND LOWER(pull_request.head_repository_full_name) IN (${names})
            AND (
              pull_request.head_repository_default_branch_name IS NOT NULL
              OR pull_request.head_repository_default_branch_availability IS NOT NULL
              OR pull_request.head_repository_default_branch_completeness IS NOT NULL
              OR pull_request.head_repository_default_branch_reason IS NOT NULL
              OR pull_request.head_repository_default_branch_source IS NOT NULL
              OR pull_request.head_repository_default_branch_mechanism IS NOT NULL
              OR pull_request.head_repository_default_branch_trigger IS NOT NULL
              OR pull_request.head_repository_default_branch_credential_type IS NOT NULL
              OR pull_request.head_repository_default_branch_credential_owner_id IS NOT NULL
              OR pull_request.head_repository_default_branch_observation_key IS NOT NULL
              OR pull_request.head_repository_default_branch_observed_at IS NOT NULL
              OR pull_request.head_repository_default_branch_event_at IS NOT NULL
            )
        )
        SELECT
          pull_request.id,
          pull_request.head_repository_github_id AS "githubRepoId",
          pull_request.head_repository_full_name AS "fullName",
          pull_request.head_repository_default_branch_name AS "defaultBranchName",
          pull_request.head_repository_default_branch_availability AS "defaultBranchAvailability",
          pull_request.head_repository_default_branch_completeness AS "defaultBranchCompleteness",
          pull_request.head_repository_default_branch_reason AS "defaultBranchReason",
          pull_request.head_repository_default_branch_source AS "defaultBranchSource",
          pull_request.head_repository_default_branch_mechanism AS "defaultBranchMechanism",
          pull_request.head_repository_default_branch_trigger AS "defaultBranchTrigger",
          pull_request.head_repository_default_branch_credential_type AS "defaultBranchCredentialType",
          pull_request.head_repository_default_branch_credential_owner_id AS "defaultBranchCredentialOwnerId",
          pull_request.head_repository_default_branch_observation_key AS "defaultBranchObservationKey",
          pull_request.head_repository_default_branch_observed_at AS "defaultBranchObservedAt",
          pull_request.head_repository_default_branch_event_at AS "defaultBranchEventAt"
        FROM pull_request_detail pull_request
        INNER JOIN candidate_authorities candidate
          ON candidate.id = pull_request.id
        WHERE candidate.authority_at IS NULL
          OR candidate.authority_at = candidate.latest_authority_at
        FOR SHARE OF pull_request
      `),
        // PLN-1775 M4 (ISS-7403): the fourth source, and the only one not
        // downstream of a GitHub App read. `verification_state = 'verified'`
        // means a `repos.get` through the org's own credential returned this
        // repository, which is what supplies the provider id and default-branch
        // group; a `pending` row is still just the desktop's claim and a
        // `denied` one is a settled negative, so neither may reach authority.
        //
        // Matched by EQUALITY, unlike the `LOWER(...)` siblings: this column's
        // only writer normalizes it through `normalizeRepoFullName` on the way
        // in, exactly as `normalizedNames` was, so the unique index on
        // `(organization_id, repository_full_name)` serves the lookup instead of
        // being defeated by an expression the index does not carry.
        tx.$queryRaw<SessionRepositoryAuthorityRow[]>(Prisma.sql`
        SELECT
          repository.id,
          repository.github_repo_id AS "githubRepoId",
          repository.repository_full_name AS "fullName",
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
        FROM github_observed_repository repository
        WHERE repository.organization_id = ${organizationId}
          AND repository.repository_full_name IN (${names})
          AND repository.verification_state = ${GitHubObservedRepositoryVerificationState.Verified}
          AND repository.github_repo_id IS NOT NULL
        FOR SHARE OF repository
      `),
      ]);
    installationRepositories.push(...installedChunk);
    publicRepositories.push(...publicChunk);
    pullRequestRepositories.push(...pullRequestChunk);
    observedRepositories.push(...observedChunk);
  }
  return [
    // Installation rows lead because they are the only source that carries a
    // `repositoryId`, and `reconcileAuthorityRows` takes the first one it sees.
    ...installationRepositories.map((repository) => ({
      repository,
      repositoryId: repository.id,
      source: RepositoryIdentitySource.Installation,
    })),
    ...publicRepositories.map((repository) => ({
      repository,
      repositoryId: null,
      source: RepositoryIdentitySource.Public,
    })),
    ...pullRequestRepositories.map((repository) => ({
      repository,
      repositoryId: null,
      source: RepositoryIdentitySource.PullRequestHead,
    })),
    // Appended last so the three established sources keep their relative order:
    // this source ADDS a candidate for repositories that had none, it does not
    // re-rank the ones that did.
    ...observedRepositories.map((repository) => ({
      repository,
      repositoryId: null,
      source: RepositoryIdentitySource.Observed,
    })),
  ];
}

/**
 * The four tables an identity can come from, carried forward so a consumer can
 * ask WHICH one answered rather than only whether one did.
 *
 * PLN-2061 M1: only `Installation` and `Public` are records of a repository
 * this organization reaches through a credential. An observed row is a
 * repository a session was seen touching, verified only far enough to pin its
 * provider id; a PR-head row is weaker still, naming a repository the provider
 * mentioned inside an answer about the BASE repository and that nothing here
 * ever read.
 */
export const RepositoryIdentitySource = {
  Installation: "installation",
  Public: "public",
  PullRequestHead: "pull_request_head",
  Observed: "observed",
} as const;
export type RepositoryIdentitySource =
  (typeof RepositoryIdentitySource)[keyof typeof RepositoryIdentitySource];

/** The columns an identity read selects; its `source` is attached by the reader. */
type SessionRepositoryIdentityColumns = Omit<
  SessionRepositoryIdentityRow,
  "source"
>;
