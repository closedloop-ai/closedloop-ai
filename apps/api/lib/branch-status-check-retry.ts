import {
  GitHubInstallationStatus,
  Prisma,
  type TransactionClient,
} from "@repo/database";

export const CheckRunRetryState = {
  Pending: "pending",
  Claimed: "claimed",
  DeadLetter: "dead_letter",
} as const;
export type CheckRunRetryState =
  (typeof CheckRunRetryState)[keyof typeof CheckRunRetryState];

const MAX_CHECK_RUN_RETRY_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
const CHECK_RUN_RETRY_CLAIM_LEASE_MS = 15 * 60 * 1000;

export type CheckRunRetryKey = {
  branchArtifactId: string;
  organizationId: string;
  repositoryId: string;
  headSha: string;
  resourceId: string;
  idempotencyKey: string;
};

export type CheckRunRetryClaim = CheckRunRetryKey & {
  attempts: number;
  installationId: string;
  owner: string;
  repo: string;
};

/**
 * Persist a credential-agnostic retry marker for a check_run provider read. The
 * durable identity is resource keyed only: branch artifact, repository, head
 * SHA, check-run resource id, and idempotency key.
 */
export async function scheduleCheckRunRetry(
  tx: TransactionClient,
  key: CheckRunRetryKey,
  reason: string,
  now: Date,
  retryAfterSeconds: number | null
): Promise<"scheduled" | "skipped_stale_branch"> {
  const retryAt = new Date(
    now.getTime() +
      Math.max(1, retryAfterSeconds ?? DEFAULT_RETRY_DELAY_SECONDS) * 1000
  );
  const duplicate = await tx.branchDetail.updateMany({
    where: guardedRetryWhere(key),
    data: {
      checkRunRetryState: CheckRunRetryState.Pending,
      checkRunRetryNextAt: retryAt,
      checkRunRetryReason: reason,
    },
  });
  if (duplicate.count > 0) {
    return "scheduled";
  }

  const result = await tx.branchDetail.updateMany({
    where: guardedCurrentHeadWhere(key),
    data: {
      checkRunRetryState: CheckRunRetryState.Pending,
      checkRunRetryHeadSha: key.headSha,
      checkRunRetryResourceId: key.resourceId,
      checkRunRetryIdempotencyKey: key.idempotencyKey,
      checkRunRetryAttempts: 0,
      checkRunRetryNextAt: retryAt,
      checkRunRetryLastAttemptAt: null,
      checkRunRetryReason: reason,
    },
  });
  return result.count > 0 ? "scheduled" : "skipped_stale_branch";
}

/**
 * Atomically claim due retry rows. Provider calls must run after this function
 * returns, outside the transaction that claimed the rows.
 */
export async function claimDueCheckRunRetries(
  tx: TransactionClient,
  now: Date,
  limit: number
): Promise<CheckRunRetryClaim[]> {
  const staleClaimBefore = new Date(
    now.getTime() - CHECK_RUN_RETRY_CLAIM_LEASE_MS
  );
  const rows = await tx.$queryRaw<CheckRunRetryRow[]>(Prisma.sql`
    WITH candidate AS (
      SELECT
        branch_detail.artifact_id,
        branch_detail.repository_id,
        branch_detail.check_run_retry_state,
        branch_detail.check_run_retry_head_sha,
        branch_detail.check_run_retry_resource_id,
        branch_detail.check_run_retry_idempotency_key
       FROM branch_detail
       INNER JOIN github_installation_repositories repositories
          ON repositories.id = branch_detail.repository_id
         AND repositories.removed_at IS NULL
       INNER JOIN github_installations installations
          ON installations.id = repositories.installation_id
         AND installations.status = ${GitHubInstallationStatus.ACTIVE}
       WHERE (
           (
             branch_detail.check_run_retry_state = ${CheckRunRetryState.Pending}
             AND (
               branch_detail.check_run_retry_next_at IS NULL
               OR branch_detail.check_run_retry_next_at <= ${now}
             )
           )
           OR (
             branch_detail.check_run_retry_state = ${CheckRunRetryState.Claimed}
             AND (
               branch_detail.check_run_retry_last_attempt_at IS NULL
               OR branch_detail.check_run_retry_last_attempt_at <= ${staleClaimBefore}
             )
           )
         )
         AND branch_detail.deleted_at IS NULL
         AND branch_detail.head_sha = branch_detail.check_run_retry_head_sha
         AND branch_detail.check_run_retry_head_sha IS NOT NULL
         AND branch_detail.check_run_retry_resource_id IS NOT NULL
         AND branch_detail.check_run_retry_idempotency_key IS NOT NULL
       ORDER BY
         branch_detail.check_run_retry_next_at ASC NULLS FIRST,
         branch_detail.updated_at ASC
       LIMIT ${Math.max(1, limit)}
       FOR UPDATE SKIP LOCKED
    ),
    claimed AS (
      UPDATE branch_detail
         SET check_run_retry_state = ${CheckRunRetryState.Claimed},
             check_run_retry_attempts = check_run_retry_attempts + 1,
             check_run_retry_last_attempt_at = ${now}
       FROM candidate
       WHERE branch_detail.artifact_id = candidate.artifact_id
         AND branch_detail.repository_id = candidate.repository_id
         AND branch_detail.check_run_retry_state = candidate.check_run_retry_state
         AND branch_detail.check_run_retry_head_sha = candidate.check_run_retry_head_sha
         AND branch_detail.check_run_retry_resource_id = candidate.check_run_retry_resource_id
         AND branch_detail.check_run_retry_idempotency_key = candidate.check_run_retry_idempotency_key
       RETURNING
         branch_detail.artifact_id,
         branch_detail.repository_id,
         branch_detail.check_run_retry_head_sha,
         branch_detail.check_run_retry_resource_id,
         branch_detail.check_run_retry_idempotency_key,
         branch_detail.check_run_retry_attempts
    )
    SELECT
      claimed.artifact_id AS "branchArtifactId",
      artifacts.organization_id AS "organizationId",
      claimed.repository_id AS "repositoryId",
      claimed.check_run_retry_head_sha AS "headSha",
      claimed.check_run_retry_resource_id AS "resourceId",
      claimed.check_run_retry_idempotency_key AS "idempotencyKey",
      claimed.check_run_retry_attempts AS "attempts",
      installations.installation_id AS "installationId",
      repositories.owner AS "owner",
      repositories.name AS "repo"
    FROM claimed
    INNER JOIN artifacts ON artifacts.id = claimed.artifact_id
    INNER JOIN github_installation_repositories repositories
       ON repositories.id = claimed.repository_id
    INNER JOIN github_installations installations
       ON installations.id = repositories.installation_id
  `);

  return rows;
}

export async function discardCheckRunRetry(
  tx: TransactionClient,
  key: CheckRunRetryKey
): Promise<"discarded" | "missing"> {
  const result = await tx.branchDetail.updateMany({
    where: exactRetryWhere(key),
    data: getCheckRunRetryResetData(),
  });
  return result.count > 0 ? "discarded" : "missing";
}

export async function clearCheckRunRetry(
  tx: TransactionClient,
  key: CheckRunRetryKey
): Promise<"cleared" | "skipped_stale_branch"> {
  const result = await tx.branchDetail.updateMany({
    where: guardedRetryWhere(key),
    data: getCheckRunRetryResetData(),
  });
  return result.count > 0 ? "cleared" : "skipped_stale_branch";
}

export async function settleRetryableCheckRunFailure(
  tx: TransactionClient,
  key: CheckRunRetryKey,
  reason: string,
  attempts: number,
  now: Date,
  retryAfterSeconds: number | null
): Promise<"retry_scheduled" | "dead_letter" | "skipped_stale_branch"> {
  if (attempts >= MAX_CHECK_RUN_RETRY_ATTEMPTS) {
    const deadLetter = await tx.branchDetail.updateMany({
      where: guardedRetryWhere(key),
      data: {
        checkRunRetryState: CheckRunRetryState.DeadLetter,
        checkRunRetryReason: reason,
        checkRunRetryNextAt: null,
        checkRunRetryLastAttemptAt: now,
      },
    });
    return deadLetter.count > 0 ? "dead_letter" : "skipped_stale_branch";
  }

  const retryAt = new Date(
    now.getTime() +
      Math.max(1, retryAfterSeconds ?? DEFAULT_RETRY_DELAY_SECONDS) * 1000
  );
  const retry = await tx.branchDetail.updateMany({
    where: guardedRetryWhere(key),
    data: {
      checkRunRetryState: CheckRunRetryState.Pending,
      checkRunRetryReason: reason,
      checkRunRetryNextAt: retryAt,
      checkRunRetryLastAttemptAt: now,
    },
  });
  return retry.count > 0 ? "retry_scheduled" : "skipped_stale_branch";
}

/** Reset patch for accepted branch head transitions and successful retries. */
export function getCheckRunRetryResetData() {
  return {
    checkRunRetryState: null,
    checkRunRetryHeadSha: null,
    checkRunRetryResourceId: null,
    checkRunRetryIdempotencyKey: null,
    checkRunRetryAttempts: 0,
    checkRunRetryNextAt: null,
    checkRunRetryLastAttemptAt: null,
    checkRunRetryReason: null,
  };
}

type CheckRunRetryRow = {
  branchArtifactId: string;
  organizationId: string;
  repositoryId: string;
  headSha: string;
  resourceId: string;
  idempotencyKey: string;
  attempts: number;
  installationId: string;
  owner: string;
  repo: string;
};

function guardedRetryWhere(key: CheckRunRetryKey) {
  return {
    artifactId: key.branchArtifactId,
    repositoryId: key.repositoryId,
    headSha: key.headSha,
    deletedAt: null,
    artifact: { organizationId: key.organizationId },
    checkRunRetryResourceId: key.resourceId,
    checkRunRetryIdempotencyKey: key.idempotencyKey,
    checkRunRetryHeadSha: key.headSha,
  };
}

function guardedCurrentHeadWhere(key: CheckRunRetryKey) {
  return {
    artifactId: key.branchArtifactId,
    repositoryId: key.repositoryId,
    headSha: key.headSha,
    deletedAt: null,
    artifact: { organizationId: key.organizationId },
  };
}

function exactRetryWhere(key: CheckRunRetryKey) {
  return {
    artifactId: key.branchArtifactId,
    repositoryId: key.repositoryId,
    artifact: { organizationId: key.organizationId },
    checkRunRetryResourceId: key.resourceId,
    checkRunRetryIdempotencyKey: key.idempotencyKey,
    checkRunRetryHeadSha: key.headSha,
  };
}
