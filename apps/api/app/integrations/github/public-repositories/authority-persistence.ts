import type { RepositoryDefaultAuthority } from "@repo/api/src/types/repository-default-identity";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
} from "@repo/api/src/types/repository-default-identity";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { repositoryDefaultAuthorityPersistenceData } from "@/lib/github/repository-default-authority";

/** Atomically refresh an existing public-repository authority snapshot. */
export async function refreshExistingPublicRepositoryAuthority(
  organizationId: string,
  githubRepoId: string,
  incoming: RepositoryDefaultAuthority | undefined
): Promise<void> {
  if (!incoming) {
    return;
  }
  await withDb.tx((tx) =>
    refreshExistingPublicRepositoryAuthorityInTransaction(
      tx,
      organizationId,
      githubRepoId,
      incoming
    )
  );
}

async function refreshExistingPublicRepositoryAuthorityInTransaction(
  tx: TransactionClient,
  organizationId: string,
  githubRepoId: string,
  incoming: RepositoryDefaultAuthority
): Promise<void> {
  const data = repositoryDefaultAuthorityPersistenceData(incoming);
  const conflict = Prisma.sql`
    ${data.defaultBranchObservedAt} = "public_repositories"."default_branch_observed_at"
    AND ${data.defaultBranchAvailability} = ${RepositoryDefaultAvailability.Available}
    AND "public_repositories"."default_branch_availability" =
      ${RepositoryDefaultAvailability.Available}
    AND ${data.defaultBranchName} IS DISTINCT FROM
      "public_repositories"."default_branch_name"
  `;
  const laterPoorer = Prisma.sql`
    ${data.defaultBranchObservedAt} > "public_repositories"."default_branch_observed_at"
    AND ${data.defaultBranchAvailability} <> ${RepositoryDefaultAvailability.Available}
    AND "public_repositories"."default_branch_name" IS NOT NULL
  `;
  const storedConflictSticky = Prisma.sql`
    "public_repositories"."default_branch_reason" = ${RepositoryDefaultReason.Conflicting}
    AND ${data.defaultBranchObservedAt} =
      "public_repositories"."default_branch_observed_at"
  `;
  // `laterPoorer` may also satisfy this predicate; the ordered CASE expressions
  // below intentionally retain the known branch and mark it stale first.
  const incomingWins = Prisma.sql`
    ${data.defaultBranchObservationKey} IS DISTINCT FROM
      "public_repositories"."default_branch_observation_key"
    AND NOT COALESCE((${conflict}), FALSE)
    AND NOT COALESCE((${storedConflictSticky}), FALSE)
    AND (
      "public_repositories"."default_branch_observed_at" IS NULL
      OR ${data.defaultBranchObservedAt} >
        "public_repositories"."default_branch_observed_at"
      OR (
        ${data.defaultBranchObservedAt} =
          "public_repositories"."default_branch_observed_at"
        AND (
          (
            ${data.defaultBranchAvailability} =
              ${RepositoryDefaultAvailability.Available}
            AND "public_repositories"."default_branch_availability" <>
              ${RepositoryDefaultAvailability.Available}
          )
          OR (
            ${data.defaultBranchAvailability} =
              "public_repositories"."default_branch_availability"
            AND ${data.defaultBranchObservationKey} >
              "public_repositories"."default_branch_observation_key"
          )
        )
      )
    )
  `;
  const updated = await tx.$queryRaw<PublicAuthorityWriteResult[]>(Prisma.sql`
    UPDATE "public_repositories"
    SET
      "default_branch_name" = CASE
        WHEN ${conflict} THEN NULL
        WHEN ${laterPoorer}
          THEN "public_repositories"."default_branch_name"
        ELSE ${data.defaultBranchName}
      END,
      "default_branch_availability" = CASE
        WHEN ${conflict}
          THEN ${RepositoryDefaultAvailability.Unavailable}
        WHEN ${laterPoorer}
          THEN ${RepositoryDefaultAvailability.Stale}
        ELSE ${data.defaultBranchAvailability}
      END,
      "default_branch_completeness" = CASE
        WHEN ${conflict}
          THEN ${RepositoryDefaultCompleteness.Unavailable}
        WHEN ${laterPoorer}
          THEN ${RepositoryDefaultCompleteness.Partial}
        ELSE ${data.defaultBranchCompleteness}
      END,
      "default_branch_reason" = CASE
        WHEN ${conflict}
          THEN ${RepositoryDefaultReason.Conflicting}
        ELSE ${data.defaultBranchReason}
      END,
      "default_branch_source" = ${data.defaultBranchSource},
      "default_branch_mechanism" = ${data.defaultBranchMechanism},
      "default_branch_trigger" = ${data.defaultBranchTrigger},
      "default_branch_credential_type" = ${data.defaultBranchCredentialType},
      "default_branch_credential_owner_id" =
        ${data.defaultBranchCredentialOwnerId}::uuid,
      "default_branch_observation_key" = ${data.defaultBranchObservationKey},
      "default_branch_observed_at" = ${data.defaultBranchObservedAt},
      "default_branch_event_at" = ${data.defaultBranchEventAt},
      "updated_at" = NOW()
    WHERE "organization_id" = ${organizationId}::uuid
      AND "github_repo_id" = ${githubRepoId}
      AND (${conflict} OR ${laterPoorer} OR ${incomingWins})
    RETURNING
      "full_name" AS "fullName",
      "default_branch_reason" AS "defaultBranchReason"
  `);
  if (updated[0]?.defaultBranchReason === RepositoryDefaultReason.Conflicting) {
    log.error("github_repository_default_authority_conflict", {
      githubRepoId,
      repositoryFullName: updated[0].fullName,
      source: incoming.provenance.source,
    });
    return;
  }
  if (updated.length > 0) {
    return;
  }
  const current = await tx.publicRepository.findUnique({
    where: { organizationId_githubRepoId: { organizationId, githubRepoId } },
    select: { defaultBranchObservedAt: true, fullName: true },
  });
  if (
    current?.defaultBranchObservedAt &&
    current.defaultBranchObservedAt > data.defaultBranchObservedAt
  ) {
    log.error("github_repository_default_authority_stale_rejected", {
      githubRepoId,
      repositoryFullName: current.fullName,
      source: incoming.provenance.source,
    });
  }
}

type PublicAuthorityWriteResult = {
  fullName: string;
  defaultBranchReason: string | null;
};
