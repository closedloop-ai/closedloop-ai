import type { RepositoryDefaultAuthority } from "@repo/api/src/types/repository-default-identity";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
} from "@repo/api/src/types/repository-default-identity";
import {
  type GitHubInstallationRepository,
  Prisma,
  type TransactionClient,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { v7 as uuidv7 } from "uuid";

/**
 * The repository fields the installation-repository upsert writes. This is the
 * canonical repo-input shape for the GitHub integration: it lives in this leaf
 * module (per `apps/api/AGENTS.md`, the composition root `service.ts` may import
 * its siblings but not vice-versa) and `service.ts` imports it from here rather
 * than redeclaring a structural duplicate.
 */
export type RepositoryInput = {
  githubRepoId: string;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  /** Omitted by legacy producers so their writes preserve stored authority. */
  defaultAuthority?: RepositoryDefaultAuthority;
};

// Postgres binds a 16-bit parameter count (max 65,535 per statement). The
// Authority adds 12 nullable values to the prior 7 per-row binds. Keep the
// chunk at 3,000 rows (57,000 row binds) under Postgres's 65,535 limit.
export const REPO_UPSERT_CHUNK_SIZE = 3000;

// Id-only filters (the tombstone `updateMany` and the post-upsert lookup) bind
// one parameter per github_repo_id plus the constant installation_id, so an
// unbounded `in`/`notIn` list overflows the same 65,535 Bind ceiling as the
// upsert. These carry ~1 param/row, so they can run much wider than the 19-bind
// upsert rows — 20,000 ids = ~20,001 params, comfortably under the ceiling
// (ISS-4618 CR: shafty023).
const REPO_ID_FILTER_CHUNK_SIZE = 20_000;

/**
 * Bulk-upsert installation repositories inside the caller's transaction as one
 * set-based `INSERT ... ON CONFLICT` per chunk. Shared by `addRepositories` and
 * `syncRepositories` so both write paths stay a bounded number of round trips
 * (not one per repo) and cannot P2028-time-out on a large webhook/OAuth batch —
 * the per-row `Promise.all(upsert)` loop they replaced serialized N round trips
 * on the transaction's single pinned connection inside Prisma's 5s window.
 *
 * Dedupes by `githubRepoId` using observed time, available-over-poorer
 * precedence, equal-time conflict detection, and deterministic key ordering
 * because a single multi-row
 * `ON CONFLICT` errors if the same conflict key appears twice in one VALUES
 * list — the previous per-row loop tolerated a repeated repo in the batch. The
 * update clears `removed_at`, reviving a repo tombstoned by a prior disconnect
 * (PLN-634). Chunked to stay under the 65,535 bind-parameter ceiling.
 */
export async function bulkUpsertInstallationRepositories(
  tx: TransactionClient,
  installationId: string,
  repositories: RepositoryInput[]
): Promise<void> {
  const uniqueRepositories = dedupeRepositoryInputs(repositories);
  for (let i = 0; i < uniqueRepositories.length; i += REPO_UPSERT_CHUNK_SIZE) {
    const chunk = uniqueRepositories.slice(i, i + REPO_UPSERT_CHUNK_SIZE);
    const rows = Prisma.join(
      chunk.map((repo) => {
        const authority = flattenRepositoryDefaultAuthority(
          repo.defaultAuthority
        );
        return Prisma.sql`(
          ${uuidv7()}::uuid,
          ${installationId}::uuid,
          ${repo.githubRepoId},
          ${repo.fullName},
          ${repo.name},
          ${repo.owner},
          ${repo.private},
          ${authority.defaultBranchName},
          ${authority.availability},
          ${authority.completeness},
          ${authority.reason},
          ${authority.source},
          ${authority.mechanism},
          ${authority.trigger},
          ${authority.credentialType},
          ${authority.credentialOwnerId}::uuid,
          ${authority.observationKey},
          ${authority.observedAt},
          ${authority.eventAt},
          NOW()
        )`;
      })
    );
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "github_installation_repositories" (
        "id",
        "installation_id",
        "github_repo_id",
        "full_name",
        "name",
        "owner",
        "private",
        "default_branch_name",
        "default_branch_availability",
        "default_branch_completeness",
        "default_branch_reason",
        "default_branch_source",
        "default_branch_mechanism",
        "default_branch_trigger",
        "default_branch_credential_type",
        "default_branch_credential_owner_id",
        "default_branch_observation_key",
        "default_branch_observed_at",
        "default_branch_event_at",
        "updated_at"
      )
      VALUES ${rows}
      ON CONFLICT ("installation_id", "github_repo_id") DO UPDATE SET
        "full_name" = CASE
          WHEN EXCLUDED."default_branch_observed_at" IS NULL OR ${repositoryAuthorityMutationAcceptedSql}
            THEN EXCLUDED."full_name"
          ELSE "github_installation_repositories"."full_name"
        END,
        "name" = CASE
          WHEN EXCLUDED."default_branch_observed_at" IS NULL OR ${repositoryAuthorityMutationAcceptedSql}
            THEN EXCLUDED."name"
          ELSE "github_installation_repositories"."name"
        END,
        "owner" = CASE
          WHEN EXCLUDED."default_branch_observed_at" IS NULL OR ${repositoryAuthorityMutationAcceptedSql}
            THEN EXCLUDED."owner"
          ELSE "github_installation_repositories"."owner"
        END,
        "private" = CASE
          WHEN EXCLUDED."default_branch_observed_at" IS NULL OR ${repositoryAuthorityMutationAcceptedSql}
            THEN EXCLUDED."private"
          ELSE "github_installation_repositories"."private"
        END,
        "default_branch_name" = CASE
          WHEN ${repositoryAuthorityConflictSql} THEN NULL
          WHEN ${repositoryAuthorityLaterPoorerSql}
            THEN "github_installation_repositories"."default_branch_name"
          WHEN ${repositoryAuthorityIncomingWinsSql}
            THEN EXCLUDED."default_branch_name"
          ELSE "github_installation_repositories"."default_branch_name"
        END,
        "default_branch_availability" = CASE
          WHEN ${repositoryAuthorityConflictSql}
            THEN ${RepositoryDefaultAvailability.Unavailable}
          WHEN ${repositoryAuthorityLaterPoorerSql}
            THEN ${RepositoryDefaultAvailability.Stale}
          WHEN ${repositoryAuthorityIncomingWinsSql}
            THEN EXCLUDED."default_branch_availability"
          ELSE "github_installation_repositories"."default_branch_availability"
        END,
        "default_branch_completeness" = CASE
          WHEN ${repositoryAuthorityConflictSql}
            THEN ${RepositoryDefaultCompleteness.Unavailable}
          WHEN ${repositoryAuthorityLaterPoorerSql}
            THEN ${RepositoryDefaultCompleteness.Partial}
          WHEN ${repositoryAuthorityIncomingWinsSql}
            THEN EXCLUDED."default_branch_completeness"
          ELSE "github_installation_repositories"."default_branch_completeness"
        END,
        "default_branch_reason" = CASE
          WHEN ${repositoryAuthorityConflictSql}
            THEN ${RepositoryDefaultReason.Conflicting}
          WHEN ${repositoryAuthorityLaterPoorerSql}
            THEN EXCLUDED."default_branch_reason"
          WHEN ${repositoryAuthorityIncomingWinsSql}
            THEN EXCLUDED."default_branch_reason"
          ELSE "github_installation_repositories"."default_branch_reason"
        END,
        "default_branch_source" = CASE
          WHEN ${repositoryAuthorityConflictSql} OR ${repositoryAuthorityLaterPoorerSql} OR ${repositoryAuthorityIncomingWinsSql}
            THEN EXCLUDED."default_branch_source"
          ELSE "github_installation_repositories"."default_branch_source"
        END,
        "default_branch_mechanism" = CASE
          WHEN ${repositoryAuthorityConflictSql} OR ${repositoryAuthorityLaterPoorerSql} OR ${repositoryAuthorityIncomingWinsSql}
            THEN EXCLUDED."default_branch_mechanism"
          ELSE "github_installation_repositories"."default_branch_mechanism"
        END,
        "default_branch_trigger" = CASE
          WHEN ${repositoryAuthorityConflictSql} OR ${repositoryAuthorityLaterPoorerSql} OR ${repositoryAuthorityIncomingWinsSql}
            THEN EXCLUDED."default_branch_trigger"
          ELSE "github_installation_repositories"."default_branch_trigger"
        END,
        "default_branch_credential_type" = CASE
          WHEN ${repositoryAuthorityConflictSql} OR ${repositoryAuthorityLaterPoorerSql} OR ${repositoryAuthorityIncomingWinsSql}
            THEN EXCLUDED."default_branch_credential_type"
          ELSE "github_installation_repositories"."default_branch_credential_type"
        END,
        "default_branch_credential_owner_id" = CASE
          WHEN ${repositoryAuthorityConflictSql} OR ${repositoryAuthorityLaterPoorerSql} OR ${repositoryAuthorityIncomingWinsSql}
            THEN EXCLUDED."default_branch_credential_owner_id"
          ELSE "github_installation_repositories"."default_branch_credential_owner_id"
        END,
        "default_branch_observation_key" = CASE
          WHEN ${repositoryAuthorityConflictSql} OR ${repositoryAuthorityLaterPoorerSql} OR ${repositoryAuthorityIncomingWinsSql}
            THEN EXCLUDED."default_branch_observation_key"
          ELSE "github_installation_repositories"."default_branch_observation_key"
        END,
        "default_branch_observed_at" = CASE
          WHEN ${repositoryAuthorityConflictSql} OR ${repositoryAuthorityLaterPoorerSql} OR ${repositoryAuthorityIncomingWinsSql}
            THEN EXCLUDED."default_branch_observed_at"
          ELSE "github_installation_repositories"."default_branch_observed_at"
        END,
        "default_branch_event_at" = CASE
          WHEN ${repositoryAuthorityConflictSql} OR ${repositoryAuthorityLaterPoorerSql} OR ${repositoryAuthorityIncomingWinsSql}
            THEN EXCLUDED."default_branch_event_at"
          ELSE "github_installation_repositories"."default_branch_event_at"
        END,
        "removed_at" = CASE
          WHEN EXCLUDED."default_branch_observed_at" IS NULL OR ${repositoryAuthorityMutationAcceptedSql}
            THEN NULL
          ELSE "github_installation_repositories"."removed_at"
        END,
        "updated_at" = NOW()
      WHERE
        (
          EXCLUDED."default_branch_observed_at" IS NULL
          AND (
            "github_installation_repositories"."full_name" IS DISTINCT FROM EXCLUDED."full_name"
            OR "github_installation_repositories"."name" IS DISTINCT FROM EXCLUDED."name"
            OR "github_installation_repositories"."owner" IS DISTINCT FROM EXCLUDED."owner"
            OR "github_installation_repositories"."private" IS DISTINCT FROM EXCLUDED."private"
            OR "github_installation_repositories"."removed_at" IS NOT NULL
          )
        )
        OR ${repositoryAuthorityConflictSql}
        OR ${repositoryAuthorityLaterPoorerSql}
        OR ${repositoryAuthorityIncomingWinsSql}
    `);
    await emitRepositoryAuthorityWriteDiagnostics(tx, installationId, chunk);
  }
}

/**
 * Fetch the installation's repository rows for `githubRepoIds`, chunking the
 * `in` filter under the 65,535 bind-parameter ceiling. Used by `addRepositories`
 * to read back the rows it just upserted; a single `in: [...ids]` findMany binds
 * one parameter per id and would overflow the Bind message on a large
 * `installation_repositories` webhook batch (ISS-4618). Ids are deduped first so
 * disjoint chunks never return the same row twice, making the chunked union
 * observably identical to the single-statement `in` query it replaces.
 */
export async function findInstallationRepositoriesByIds(
  tx: TransactionClient,
  installationId: string,
  githubRepoIds: string[]
): Promise<GitHubInstallationRepository[]> {
  const uniqueIds = [...new Set(githubRepoIds)];
  const rows: GitHubInstallationRepository[] = [];
  for (let i = 0; i < uniqueIds.length; i += REPO_ID_FILTER_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + REPO_ID_FILTER_CHUNK_SIZE);
    const found = await tx.gitHubInstallationRepository.findMany({
      where: { installationId, githubRepoId: { in: chunk } },
    });
    rows.push(...found);
  }
  return rows;
}

/**
 * Tombstone (set `removed_at`) exactly the installation's currently non-removed
 * repositories whose `githubRepoId` is absent from `incomingRepoIds`, matching
 * the semantics of a single `notIn: [...incomingRepoIds]` updateMany. Reads the
 * current non-removed id set (bound only to `installation_id`), diffs it in
 * memory, then updates the difference by explicit id in chunks — so no statement
 * binds one parameter per incoming id, which would overflow Postgres's 65,535
 * bind-parameter ceiling on a large sync grant (ISS-4618). Only the delta is
 * written, so a steady-state re-sync issues no update at all. All incoming
 * repos are (re)vived by the caller's subsequent bulk upsert.
 */
export async function tombstoneRepositoriesAbsentFrom(
  tx: TransactionClient,
  installationId: string,
  incomingRepoIds: Set<string>
): Promise<void> {
  const existing = await tx.gitHubInstallationRepository.findMany({
    where: { installationId, removedAt: null },
    select: { githubRepoId: true },
  });
  const toTombstone = existing
    .map((row) => row.githubRepoId)
    .filter((githubRepoId) => !incomingRepoIds.has(githubRepoId));
  if (toTombstone.length === 0) {
    return;
  }
  const removedAt = new Date();
  for (let i = 0; i < toTombstone.length; i += REPO_ID_FILTER_CHUNK_SIZE) {
    const chunk = toTombstone.slice(i, i + REPO_ID_FILTER_CHUNK_SIZE);
    await tx.gitHubInstallationRepository.updateMany({
      where: {
        installationId,
        githubRepoId: { in: chunk },
        removedAt: null,
      },
      data: { removedAt },
    });
  }
}

type FlattenedRepositoryDefaultAuthority = {
  defaultBranchName: string | null;
  availability: string | null;
  completeness: string | null;
  reason: string | null;
  source: string | null;
  mechanism: string | null;
  trigger: string | null;
  credentialType: string | null;
  credentialOwnerId: string | null;
  observationKey: string | null;
  observedAt: Date | null;
  eventAt: Date | null;
};

function flattenRepositoryDefaultAuthority(
  authority: RepositoryDefaultAuthority | undefined
): FlattenedRepositoryDefaultAuthority {
  if (!authority) {
    return emptyFlattenedRepositoryDefaultAuthority;
  }
  return {
    defaultBranchName:
      "defaultBranch" in authority.evidence
        ? authority.evidence.defaultBranch
        : null,
    availability: authority.evidence.availability,
    completeness: authority.evidence.completeness,
    reason: "reason" in authority.evidence ? authority.evidence.reason : null,
    source: authority.provenance.source,
    mechanism: authority.provenance.mechanism,
    trigger: authority.provenance.trigger,
    credentialType: authority.provenance.credentialType,
    credentialOwnerId: authority.provenance.credentialOwnerId ?? null,
    observationKey: authority.provenance.observationKey,
    observedAt: new Date(authority.provenance.observedAt),
    eventAt: authority.provenance.eventAt
      ? new Date(authority.provenance.eventAt)
      : null,
  };
}

function dedupeRepositoryInputs(
  repositories: RepositoryInput[]
): RepositoryInput[] {
  const byRepositoryId = new Map<string, RepositoryInput>();
  for (const repository of repositories) {
    const existing = byRepositoryId.get(repository.githubRepoId);
    byRepositoryId.set(
      repository.githubRepoId,
      existing
        ? reconcileDuplicateRepositoryInput(existing, repository)
        : repository
    );
  }
  return [...byRepositoryId.values()];
}

function reconcileDuplicateRepositoryInput(
  existing: RepositoryInput,
  incoming: RepositoryInput
): RepositoryInput {
  const existingAuthority = existing.defaultAuthority;
  const incomingAuthority = incoming.defaultAuthority;
  if (!incomingAuthority) {
    return existingAuthority
      ? { ...incoming, defaultAuthority: existingAuthority }
      : incoming;
  }
  if (!existingAuthority) {
    return incoming;
  }
  const existingTime = Date.parse(existingAuthority.provenance.observedAt);
  const incomingTime = Date.parse(incomingAuthority.provenance.observedAt);
  if (
    existingAuthority.provenance.observationKey ===
    incomingAuthority.provenance.observationKey
  ) {
    return existing;
  }
  if (incomingTime !== existingTime) {
    return reconcileDifferentTimeRepositoryInput(
      existing,
      incoming,
      existingAuthority,
      incomingAuthority
    );
  }
  if (
    "reason" in existingAuthority.evidence &&
    existingAuthority.evidence.reason === RepositoryDefaultReason.Conflicting
  ) {
    return existing;
  }
  const existingAvailable =
    existingAuthority.evidence.availability ===
    RepositoryDefaultAvailability.Available;
  const incomingAvailable =
    incomingAuthority.evidence.availability ===
    RepositoryDefaultAvailability.Available;
  if (existingAvailable !== incomingAvailable) {
    return incomingAvailable ? incoming : existing;
  }
  if (
    existingAvailable &&
    "defaultBranch" in existingAuthority.evidence &&
    "defaultBranch" in incomingAuthority.evidence &&
    existingAuthority.evidence.defaultBranch !==
      incomingAuthority.evidence.defaultBranch
  ) {
    const chosen = chooseDeterministicAuthority(
      existingAuthority,
      incomingAuthority
    );
    return {
      ...incoming,
      defaultAuthority: {
        ...chosen,
        evidence: {
          availability: RepositoryDefaultAvailability.Unavailable,
          completeness: RepositoryDefaultCompleteness.Unavailable,
          reason: RepositoryDefaultReason.Conflicting,
        },
      },
    };
  }
  return chooseDeterministicAuthority(existingAuthority, incomingAuthority) ===
    incomingAuthority
    ? incoming
    : existing;
}

function reconcileDifferentTimeRepositoryInput(
  existing: RepositoryInput,
  incoming: RepositoryInput,
  existingAuthority: RepositoryDefaultAuthority,
  incomingAuthority: RepositoryDefaultAuthority
): RepositoryInput {
  if (
    Date.parse(incomingAuthority.provenance.observedAt) <
    Date.parse(existingAuthority.provenance.observedAt)
  ) {
    return existing;
  }
  if (
    existingAuthority.evidence.availability !==
      RepositoryDefaultAvailability.Available ||
    incomingAuthority.evidence.availability ===
      RepositoryDefaultAvailability.Available ||
    !("defaultBranch" in existingAuthority.evidence)
  ) {
    return incoming;
  }
  return {
    ...incoming,
    defaultAuthority: {
      ...incomingAuthority,
      evidence: {
        availability: RepositoryDefaultAvailability.Stale,
        completeness: RepositoryDefaultCompleteness.Partial,
        defaultBranch: existingAuthority.evidence.defaultBranch,
        reason:
          "reason" in incomingAuthority.evidence
            ? incomingAuthority.evidence.reason
            : RepositoryDefaultReason.ProviderError,
      },
    },
  };
}

function chooseDeterministicAuthority(
  existing: RepositoryDefaultAuthority,
  incoming: RepositoryDefaultAuthority
): RepositoryDefaultAuthority {
  return incoming.provenance.observationKey > existing.provenance.observationKey
    ? incoming
    : existing;
}

const emptyFlattenedRepositoryDefaultAuthority: FlattenedRepositoryDefaultAuthority =
  {
    defaultBranchName: null,
    availability: null,
    completeness: null,
    reason: null,
    source: null,
    mechanism: null,
    trigger: null,
    credentialType: null,
    credentialOwnerId: null,
    observationKey: null,
    observedAt: null,
    eventAt: null,
  };

const repositoryAuthorityConflictSql = Prisma.sql`
  EXCLUDED."default_branch_observed_at" IS NOT NULL
  AND EXCLUDED."default_branch_observed_at" =
    "github_installation_repositories"."default_branch_observed_at"
  AND EXCLUDED."default_branch_availability" =
    ${RepositoryDefaultAvailability.Available}
  AND "github_installation_repositories"."default_branch_availability" =
    ${RepositoryDefaultAvailability.Available}
  AND EXCLUDED."default_branch_name" IS DISTINCT FROM
    "github_installation_repositories"."default_branch_name"
`;

const repositoryAuthorityLaterPoorerSql = Prisma.sql`
  EXCLUDED."default_branch_observed_at" >
    "github_installation_repositories"."default_branch_observed_at"
  AND EXCLUDED."default_branch_availability" <>
    ${RepositoryDefaultAvailability.Available}
  AND "github_installation_repositories"."default_branch_name" IS NOT NULL
`;

const repositoryAuthorityStoredConflictStickySql = Prisma.sql`
  "github_installation_repositories"."default_branch_reason" =
    ${RepositoryDefaultReason.Conflicting}
  AND EXCLUDED."default_branch_observed_at" =
    "github_installation_repositories"."default_branch_observed_at"
`;

const repositoryAuthorityIncomingWinsSql = Prisma.sql`
  EXCLUDED."default_branch_observed_at" IS NOT NULL
  AND EXCLUDED."default_branch_observation_key" IS DISTINCT FROM
    "github_installation_repositories"."default_branch_observation_key"
  AND NOT COALESCE((${repositoryAuthorityConflictSql}), FALSE)
  AND NOT COALESCE((${repositoryAuthorityLaterPoorerSql}), FALSE)
  AND NOT COALESCE((${repositoryAuthorityStoredConflictStickySql}), FALSE)
  AND (
    "github_installation_repositories"."default_branch_observed_at" IS NULL
    OR EXCLUDED."default_branch_observed_at" >
      "github_installation_repositories"."default_branch_observed_at"
    OR (
      EXCLUDED."default_branch_observed_at" =
        "github_installation_repositories"."default_branch_observed_at"
      AND (
        (
          EXCLUDED."default_branch_availability" =
            ${RepositoryDefaultAvailability.Available}
          AND "github_installation_repositories"."default_branch_availability" <>
            ${RepositoryDefaultAvailability.Available}
        )
        OR (
          EXCLUDED."default_branch_availability" =
            "github_installation_repositories"."default_branch_availability"
          AND EXCLUDED."default_branch_observation_key" >
            "github_installation_repositories"."default_branch_observation_key"
        )
      )
    )
  )
`;

const repositoryAuthorityMutationAcceptedSql = Prisma.sql`
  ${repositoryAuthorityConflictSql}
  OR ${repositoryAuthorityLaterPoorerSql}
  OR ${repositoryAuthorityIncomingWinsSql}
`;

type StoredRepositoryAuthorityDiagnostic = {
  githubRepoId: string;
  defaultBranchObservedAt: Date | null;
  defaultBranchReason: string | null;
};

async function emitRepositoryAuthorityWriteDiagnostics(
  tx: TransactionClient,
  installationId: string,
  repositories: RepositoryInput[]
): Promise<void> {
  const authorityRepositories = repositories.filter(
    (repository) => repository.defaultAuthority
  );
  if (authorityRepositories.length === 0) {
    return;
  }
  const stored = await tx.$queryRaw<StoredRepositoryAuthorityDiagnostic[]>(
    Prisma.sql`
      SELECT
        "github_repo_id" AS "githubRepoId",
        "default_branch_observed_at" AS "defaultBranchObservedAt",
        "default_branch_reason" AS "defaultBranchReason"
      FROM "github_installation_repositories"
      WHERE "installation_id" = ${installationId}::uuid
        AND "github_repo_id" IN (${Prisma.join(
          authorityRepositories.map((repository) => repository.githubRepoId)
        )})
    `
  );
  const storedByRepositoryId = new Map(
    stored.map((row) => [row.githubRepoId, row])
  );
  for (const repository of authorityRepositories) {
    const authority = repository.defaultAuthority;
    const row = storedByRepositoryId.get(repository.githubRepoId);
    if (!(authority && row?.defaultBranchObservedAt)) {
      continue;
    }
    const incomingObservedAt = new Date(authority.provenance.observedAt);
    if (row.defaultBranchObservedAt > incomingObservedAt) {
      log.error("github_repository_default_authority_stale_rejected", {
        githubRepoId: repository.githubRepoId,
        repositoryFullName: repository.fullName,
        source: authority.provenance.source,
      });
    } else if (
      row.defaultBranchObservedAt.getTime() === incomingObservedAt.getTime() &&
      row.defaultBranchReason === RepositoryDefaultReason.Conflicting
    ) {
      log.error("github_repository_default_authority_conflict", {
        githubRepoId: repository.githubRepoId,
        repositoryFullName: repository.fullName,
        source: authority.provenance.source,
      });
    }
  }
}
