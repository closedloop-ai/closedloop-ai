import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  ArtifactRefRelation,
  syncedPrioritySchema,
} from "@repo/api/src/types/session-artifact-link";
import { persistedSessionPrRefSchema } from "@repo/api/src/types/session-pr-link-metadata";
import { Prisma, type TransactionClient } from "@repo/database";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import {
  CloudBranchNonMaterializationKind,
  type CloudBranchNonMaterializationKind as CloudBranchNonMaterializationKindType,
} from "@/app/branches/branch-write-eligibility";
import { chunksOf } from "@/lib/chunks-of";
import { POSTGRES_MAX_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";
import {
  BranchMaterializationRetryEventOutcome,
  BranchMaterializationRetryTerminalReason,
  emitBranchMaterializationRetryEvent,
  isRevivableBranchMaterializationTerminalReason,
} from "./branch-materialization-retry-monitor";
import {
  BranchMaterializationRetryPolicy,
  BranchMaterializationRetryReason,
} from "./branch-materialization-retry-policy";
import type { BranchRefAggregate } from "./branch-ref-aggregate";
import {
  mergeBranchRefAggregates,
  mergeBranchRefAggregatesReplacingPullRequestRefs,
  normalizeBranchRefAggregatePrRefs,
} from "./branch-ref-aggregate";

/** Internal lifecycle values; these never participate in Product reads. */
export const BranchMaterializationRetryState = {
  Pending: "pending",
  Claimed: "claimed",
  Terminal: "terminal",
  DeadLetter: "dead_letter",
} as const;
export type BranchMaterializationRetryState =
  (typeof BranchMaterializationRetryState)[keyof typeof BranchMaterializationRetryState];

const CLAIM_LEASE_MS = 15 * 60 * 1000;
const MAX_CLAIM_BATCH = 50;

export type EnqueueBranchMaterializationRetryInput = {
  organizationId: string;
  sourceArtifactId: string;
  aggregate: BranchRefAggregate;
  reason: typeof BranchMaterializationRetryReason.AuthorityUnavailable;
};

export type EnqueueBranchMaterializationRetryResult =
  | { status: "scheduled" | "already_scheduled" | "revived"; retryId: string }
  | { status: "invalid_context" };

export type BranchMaterializationRetryClaim = {
  id: string;
  organizationId: string;
  sourceArtifactId: string;
  repositoryFullName: string;
  branchName: string;
  branchRef: unknown;
  attempts: number;
  claimGeneration: number;
  createdAt: Date;
  projectId: string | null;
  validationReason: BranchMaterializationRetryTerminalReason | null;
};

export type BranchMaterializationRetryFence = Pick<
  BranchMaterializationRetryClaim,
  "id" | "organizationId" | "claimGeneration"
>;

export type BranchMaterializationRetryWriteGuardResult =
  | { status: "current"; branchRef: unknown; projectId: string | null }
  | { status: "stale_claim" }
  | {
      status: "terminal";
      reason: BranchMaterializationRetryTerminalReason;
    };

export async function enqueueBranchMaterializationRetriesTx(
  tx: TransactionClient,
  input: {
    organizationId: string;
    sourceArtifactId: string;
    aggregates: readonly BranchRefAggregate[];
  },
  now = new Date()
): Promise<EnqueueBranchMaterializationRetryResult[]> {
  const prepared = prepareBranchRetryEnqueueInputs(input);
  if (prepared.entries.length === 0) {
    return prepared.resultKeys.map(() => ({ status: "invalid_context" }));
  }

  const resultsByKey = await enqueuePreparedBranchMaterializationRetriesTx(
    tx,
    prepared.entries,
    now
  );
  return prepared.resultKeys.map((key) =>
    key === null
      ? { status: "invalid_context" }
      : (resultsByKey.get(key) ?? { status: "invalid_context" })
  );
}

/** Atomically validate and enqueue one full-fidelity Branch ref aggregate. */
export async function enqueueBranchMaterializationRetryTx(
  tx: TransactionClient,
  input: EnqueueBranchMaterializationRetryInput,
  now = new Date()
): Promise<EnqueueBranchMaterializationRetryResult> {
  const [result] = await enqueueBranchMaterializationRetriesTx(
    tx,
    {
      organizationId: input.organizationId,
      sourceArtifactId: input.sourceArtifactId,
      aggregates: [input.aggregate],
    },
    now
  );
  return result ?? { status: "invalid_context" };
}

async function enqueuePreparedBranchMaterializationRetriesTx(
  tx: TransactionClient,
  entries: readonly PreparedBranchRetryEnqueue[],
  now: Date
): Promise<Map<string, EnqueueBranchMaterializationRetryResult>> {
  await lockBranchRetryIdentities(
    tx,
    entries.map((entry) => entry.input)
  );
  const existingRows = await readExistingBranchRetries(
    tx,
    entries.map((entry) => entry.input)
  );
  const existingByKey = new Map(
    existingRows.map((row) => [retryIdentityKeyFromExisting(row), row])
  );
  const results = new Map<string, EnqueueBranchMaterializationRetryResult>();
  const writeRows: BranchRetryBulkWriteRow[] = [];

  for (const entry of entries) {
    const existing = existingByKey.get(entry.key);
    const aggregate = mergeStoredAggregate(
      existing?.branchRef,
      entry.input.aggregate
    );
    const writeRow = buildBranchRetryBulkWriteRow(
      entry,
      existing,
      aggregate,
      now
    );
    if (!writeRow) {
      if (existing) {
        results.set(entry.key, {
          status: "already_scheduled",
          retryId: existing.retryId,
        });
      }
      continue;
    }
    writeRows.push(writeRow);
  }

  const writtenRows = await upsertBranchRetries(tx, writeRows, now);
  for (const row of writtenRows) {
    const result = {
      status: row.outcome,
      retryId: row.retryId,
    } satisfies EnqueueBranchMaterializationRetryResult;
    results.set(row.identityKey, result);
    if (row.outcome === "scheduled" || row.outcome === "revived") {
      emitBranchMaterializationRetryEvent({
        organizationId: row.organizationId,
        retryId: row.retryId,
        sourceArtifactId: row.sourceArtifactId,
        repositoryFullName: row.repositoryFullName,
        branchName: row.branchName,
        outcome: BranchMaterializationRetryEventOutcome.Queued,
        attempts: row.attempts,
        reason: BranchMaterializationRetryReason.AuthorityUnavailable,
      });
    }
  }

  return results;
}

function prepareBranchRetryEnqueueInputs(input: {
  organizationId: string;
  sourceArtifactId: string;
  aggregates: readonly BranchRefAggregate[];
}): {
  entries: PreparedBranchRetryEnqueue[];
  resultKeys: Array<string | null>;
} {
  const entriesByKey = new Map<string, PreparedBranchRetryEnqueue>();
  const resultKeys: Array<string | null> = [];
  for (const rawAggregate of input.aggregates) {
    const aggregate = normalizeBranchRefAggregatePrRefs(rawAggregate);
    if (!validAggregateIdentity(aggregate)) {
      resultKeys.push(null);
      continue;
    }

    const key = retryIdentityKey(input, aggregate);
    const existing = entriesByKey.get(key);
    if (existing) {
      existing.input.aggregate = mergeBranchRefAggregates(
        existing.input.aggregate,
        aggregate
      );
      resultKeys.push(key);
      continue;
    }

    entriesByKey.set(key, {
      key,
      input: {
        organizationId: input.organizationId,
        sourceArtifactId: input.sourceArtifactId,
        aggregate,
        reason: BranchMaterializationRetryReason.AuthorityUnavailable,
      },
    });
    resultKeys.push(key);
  }

  return { entries: [...entriesByKey.values()], resultKeys };
}

/** Claim due and expired rows under one monotonic generation fence. */
export async function claimDueBranchMaterializationRetries(
  tx: TransactionClient,
  now: Date,
  limit: number,
  options: { excludedOrganizationIds?: readonly string[] } = {}
): Promise<BranchMaterializationRetryClaim[]> {
  const staleClaimBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
  const boundedLimit = Math.min(MAX_CLAIM_BATCH, Math.max(1, limit));
  const orgExclusion = branchMaterializationRetryOrgExclusion(
    options.excludedOrganizationIds ?? []
  );

  return await tx.$queryRaw<BranchMaterializationRetryClaim[]>(Prisma.sql`
    WITH candidate AS (
      SELECT
        retries.id,
        retries.state,
        retries.claim_generation
      FROM branch_materialization_retries retries
      WHERE (
          (
            retries.state = ${BranchMaterializationRetryState.Pending}
            AND retries.next_attempt_at <= ${now}
          )
          OR (
            retries.state = ${BranchMaterializationRetryState.Claimed}
            AND (
              retries.claimed_at IS NULL
              OR retries.claimed_at <= ${staleClaimBefore}
            )
          )
        )
        ${orgExclusion}
      ORDER BY retries.next_attempt_at ASC, retries.created_at ASC, retries.id ASC
      LIMIT ${boundedLimit}
      FOR UPDATE OF retries SKIP LOCKED
    ),
    claimed AS (
      UPDATE branch_materialization_retries retries
      SET state = ${BranchMaterializationRetryState.Claimed},
          attempts = retries.attempts + 1,
          claimed_at = ${now},
          claim_generation = retries.claim_generation + 1,
          updated_at = ${now}
      FROM candidate
      WHERE retries.id = candidate.id
        AND retries.state = candidate.state
        AND retries.claim_generation = candidate.claim_generation
      RETURNING retries.*
    )
    SELECT
      claimed.id,
      claimed.organization_id AS "organizationId",
      claimed.source_artifact_id AS "sourceArtifactId",
      claimed.repository_full_name AS "repositoryFullName",
      claimed.branch_name AS "branchName",
      claimed.branch_ref AS "branchRef",
      claimed.attempts,
      claimed.claim_generation AS "claimGeneration",
      claimed.created_at AS "createdAt",
      source_artifacts.project_id AS "projectId",
      CASE
        WHEN source_artifacts.id IS NULL
          THEN ${BranchMaterializationRetryTerminalReason.SourceMissing}
        WHEN source_artifacts.organization_id <> claimed.organization_id
          THEN ${BranchMaterializationRetryTerminalReason.CrossOrganization}
        WHEN source_artifacts.type::text IS DISTINCT FROM ${ArtifactType.Session}
          THEN ${BranchMaterializationRetryTerminalReason.CorruptState}
        ELSE NULL
      END AS "validationReason"
    FROM claimed
    LEFT JOIN artifacts source_artifacts
      ON source_artifacts.id = claimed.source_artifact_id
  `);
}

/** Delete the exact successfully materialized claim. */
export async function settleSuccessfulBranchMaterializationRetry(
  tx: TransactionClient,
  fence: BranchMaterializationRetryFence
): Promise<"settled" | "stale_claim"> {
  const count = await tx.$executeRaw(Prisma.sql`
    DELETE FROM branch_materialization_retries
    WHERE id = CAST(${fence.id} AS UUID)
      AND organization_id = CAST(${fence.organizationId} AS UUID)
      AND state = ${BranchMaterializationRetryState.Claimed}
      AND claim_generation = ${fence.claimGeneration}
  `);
  return count === 1 ? "settled" : "stale_claim";
}

/** Revalidate the exact claim and source artifact before a Product write. */
export async function revalidateCurrentBranchMaterializationRetryClaim(
  tx: TransactionClient,
  claim: BranchMaterializationRetryClaim
): Promise<BranchMaterializationRetryWriteGuardResult> {
  const rows = await tx.$queryRaw<WriteGuardRow[]>(Prisma.sql`
    SELECT
      retries.branch_ref AS "branchRef",
      CASE
        WHEN source_artifacts.id IS NULL
          THEN ${BranchMaterializationRetryTerminalReason.SourceMissing}
        WHEN source_artifacts.organization_id <> retries.organization_id
          THEN ${BranchMaterializationRetryTerminalReason.CrossOrganization}
        WHEN retries.source_artifact_id IS DISTINCT FROM CAST(${claim.sourceArtifactId} AS UUID)
          OR retries.repository_full_name IS DISTINCT FROM ${claim.repositoryFullName}
          OR retries.branch_name IS DISTINCT FROM ${claim.branchName}
          THEN ${BranchMaterializationRetryTerminalReason.CorruptState}
        WHEN source_artifacts.type::text IS DISTINCT FROM ${ArtifactType.Session}
          THEN ${BranchMaterializationRetryTerminalReason.CorruptState}
        ELSE NULL
      END AS "validationReason",
      source_artifacts.project_id AS "projectId"
    FROM branch_materialization_retries retries
    LEFT JOIN artifacts source_artifacts
      ON source_artifacts.id = retries.source_artifact_id
    WHERE retries.id = CAST(${claim.id} AS UUID)
      AND retries.organization_id = CAST(${claim.organizationId} AS UUID)
      AND retries.state = ${BranchMaterializationRetryState.Claimed}
      AND retries.claim_generation = ${claim.claimGeneration}
    FOR UPDATE OF retries
  `);
  const row = rows[0];
  if (!row) {
    return { status: "stale_claim" };
  }
  if (row.validationReason) {
    return { status: "terminal", reason: row.validationReason };
  }
  return {
    status: "current",
    branchRef: row.branchRef,
    projectId: row.projectId,
  };
}

/** Return the exact claim to pending without touching a newer generation. */
export async function rescheduleBranchMaterializationRetry(
  tx: TransactionClient,
  fence: BranchMaterializationRetryFence,
  nextAttemptAt: Date,
  now: Date
): Promise<"settled" | "stale_claim"> {
  const count = await tx.$executeRaw(Prisma.sql`
    UPDATE branch_materialization_retries
    SET state = ${BranchMaterializationRetryState.Pending},
        reason = ${BranchMaterializationRetryReason.AuthorityUnavailable},
        next_attempt_at = ${nextAttemptAt},
        claimed_at = NULL,
        updated_at = ${now}
    WHERE id = CAST(${fence.id} AS UUID)
      AND organization_id = CAST(${fence.organizationId} AS UUID)
      AND state = ${BranchMaterializationRetryState.Claimed}
      AND claim_generation = ${fence.claimGeneration}
  `);
  return count === 1 ? "settled" : "stale_claim";
}

/** Settle one terminal or dead-letter state under the exact claim fence. */
export async function settleTerminalBranchMaterializationRetry(
  tx: TransactionClient,
  fence: BranchMaterializationRetryFence,
  state:
    | typeof BranchMaterializationRetryState.Terminal
    | typeof BranchMaterializationRetryState.DeadLetter,
  reason: BranchMaterializationRetryTerminalReason,
  now: Date
): Promise<"settled" | "stale_claim"> {
  const count = await tx.$executeRaw(Prisma.sql`
    UPDATE branch_materialization_retries
    SET state = ${state},
        reason = ${reason},
        next_attempt_at = ${now},
        claimed_at = NULL,
        updated_at = ${now}
    WHERE id = CAST(${fence.id} AS UUID)
      AND organization_id = CAST(${fence.organizationId} AS UUID)
      AND state = ${BranchMaterializationRetryState.Claimed}
      AND claim_generation = ${fence.claimGeneration}
  `);
  return count === 1 ? "settled" : "stale_claim";
}

/** Drop stale retry evidence after a direct ingest has written the canonical link. */
export async function deleteBranchMaterializationRetryForMaterializedAggregateTx(
  tx: TransactionClient,
  input: {
    organizationId: string;
    sourceArtifactId: string;
    aggregate: BranchRefAggregate;
  }
): Promise<number> {
  if (!validAggregateIdentity(input.aggregate)) {
    return 0;
  }
  await lockBranchRetryIdentityWithExecute(tx, input);
  return await tx.$executeRaw(Prisma.sql`
    DELETE FROM branch_materialization_retries
    WHERE organization_id = CAST(${input.organizationId} AS UUID)
      AND source_artifact_id = CAST(${input.sourceArtifactId} AS UUID)
      AND repository_full_name = ${input.aggregate.repositoryFullName}
      AND branch_name = ${input.aggregate.branchName}
  `);
}

export function parseBranchMaterializationRetryAggregate(
  value: unknown
): BranchRefAggregate | null {
  const parsed = branchMaterializationRetryPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isRetryableBranchMaterializationCause(
  cause: CloudBranchNonMaterializationKindType
): boolean {
  return (
    cause === CloudBranchNonMaterializationKind.AuthorityUnavailable ||
    // ISS-8148: a branch deferred for want of push evidence must be RETRIED
    // from this durable payload, not from whatever the next sync happens to
    // replay. The Desktop caps a session's non-commit refs, so a push that
    // lands after the cap has evicted the branch ref would otherwise never
    // reach this lane again and the deferral would become a silent drop.
    cause === CloudBranchNonMaterializationKind.NotPushed
  );
}

export function terminalReasonFromBranchMaterializationCause(
  cause: CloudBranchNonMaterializationKindType
): BranchMaterializationRetryTerminalReason {
  if (cause === CloudBranchNonMaterializationKind.ConflictingAuthority) {
    return BranchMaterializationRetryTerminalReason.ConflictingAuthority;
  }
  if (cause === CloudBranchNonMaterializationKind.DefaultBranch) {
    return BranchMaterializationRetryTerminalReason.DefaultBranch;
  }
  if (cause === CloudBranchNonMaterializationKind.IdentityMismatch) {
    return BranchMaterializationRetryTerminalReason.IdentityMismatch;
  }
  if (cause === CloudBranchNonMaterializationKind.NotPushed) {
    return BranchMaterializationRetryTerminalReason.NotPushed;
  }
  return BranchMaterializationRetryTerminalReason.CorruptState;
}

function validAggregateIdentity(aggregate: BranchRefAggregate): boolean {
  return (
    aggregate.repositoryFullName.trim().length > 0 &&
    aggregate.branchName.trim().length > 0
  );
}

export async function lockBranchRetryIdentities(
  tx: TransactionClient,
  inputs: readonly EnqueueBranchMaterializationRetryInput[]
): Promise<void> {
  if (inputs.length === 0) {
    return;
  }
  // Sort before chunking so every transaction takes the same global key order.
  const ordered = [...inputs].sort(compareBranchRetryIdentity);
  for (const chunk of chunksOf(ordered, BRANCH_RETRY_IDENTITY_CHUNK_SIZE)) {
    await lockBranchRetryIdentityChunk(tx, chunk);
  }
}

async function lockBranchRetryIdentityChunk(
  tx: TransactionClient,
  inputs: readonly EnqueueBranchMaterializationRetryInput[]
): Promise<void> {
  const values = inputs.map((input) => branchRetryIdentityValue(input));
  await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
    WITH identities(organization_id, source_artifact_id, repository_full_name, branch_name) AS (
      VALUES ${Prisma.join(values)}
    ),
    ordered_identities AS (
      SELECT *
      FROM identities
      ORDER BY
        organization_id::text ASC,
        source_artifact_id::text ASC,
        repository_full_name ASC,
        branch_name ASC
    ),
    acquired AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          CONCAT_WS(
            ':',
            CAST(organization_id AS TEXT),
            CAST(source_artifact_id AS TEXT),
            repository_full_name,
            branch_name
          ),
          0
        )
      )
      FROM ordered_identities
    )
    SELECT TRUE AS locked
    FROM acquired
  `);
}

async function lockBranchRetryIdentityWithExecute(
  tx: TransactionClient,
  input: {
    organizationId: string;
    sourceArtifactId: string;
    aggregate: BranchRefAggregate;
  }
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        CONCAT_WS(
          ':',
          CAST(${input.organizationId} AS TEXT),
          CAST(${input.sourceArtifactId} AS TEXT),
          CAST(${input.aggregate.repositoryFullName} AS TEXT),
          CAST(${input.aggregate.branchName} AS TEXT)
        ),
        0
      )
    )
  `);
}

async function readExistingBranchRetries(
  tx: TransactionClient,
  inputs: readonly EnqueueBranchMaterializationRetryInput[]
): Promise<ExistingBranchRetryRow[]> {
  if (inputs.length === 0) {
    return [];
  }
  const rows: ExistingBranchRetryRow[] = [];
  for (const chunk of chunksOf(inputs, BRANCH_RETRY_IDENTITY_CHUNK_SIZE)) {
    rows.push(...(await readExistingBranchRetryChunk(tx, chunk)));
  }
  return rows;
}

async function readExistingBranchRetryChunk(
  tx: TransactionClient,
  inputs: readonly EnqueueBranchMaterializationRetryInput[]
): Promise<ExistingBranchRetryRow[]> {
  const values = inputs.map((input) => branchRetryIdentityValue(input));
  return await tx.$queryRaw<ExistingBranchRetryRow[]>(Prisma.sql`
    WITH identities(organization_id, source_artifact_id, repository_full_name, branch_name) AS (
      VALUES ${Prisma.join(values)}
    )
    SELECT
      retries.id AS "retryId",
      retries.organization_id AS "organizationId",
      retries.source_artifact_id AS "sourceArtifactId",
      retries.repository_full_name AS "repositoryFullName",
      retries.branch_name AS "branchName",
      retries.branch_ref AS "branchRef",
      retries.state,
      retries.reason,
      retries.attempts,
      retries.next_attempt_at AS "nextAttemptAt",
      retries.created_at AS "createdAt"
    FROM branch_materialization_retries retries
    JOIN identities
      ON identities.organization_id = retries.organization_id
      AND identities.source_artifact_id = retries.source_artifact_id
      AND identities.repository_full_name = retries.repository_full_name
      AND identities.branch_name = retries.branch_name
    FOR UPDATE OF retries
  `);
}

async function upsertBranchRetries(
  tx: TransactionClient,
  writeRows: readonly BranchRetryBulkWriteRow[],
  now: Date
): Promise<EnqueueRow[]> {
  if (writeRows.length === 0) {
    return [];
  }
  const written: EnqueueRow[] = [];
  for (const chunk of chunksOf(writeRows, BRANCH_RETRY_WRITE_CHUNK_SIZE)) {
    written.push(...(await upsertBranchRetryChunk(tx, chunk, now)));
  }
  return written;
}

async function upsertBranchRetryChunk(
  tx: TransactionClient,
  writeRows: readonly BranchRetryBulkWriteRow[],
  now: Date
): Promise<EnqueueRow[]> {
  const values = writeRows.map((row) => branchRetryBulkWriteValue(row, now));
  return await tx.$queryRaw<EnqueueRow[]>(Prisma.sql`
    WITH incoming(
      identity_key,
      id,
      organization_id,
      source_artifact_id,
      repository_full_name,
      branch_name,
      branch_ref,
      state,
      reason,
      attempts,
      next_attempt_at,
      claim_generation,
      created_at,
      written_at,
      outcome
    ) AS (
      VALUES ${Prisma.join(values)}
    ),
    eligible AS (
      SELECT incoming.*
      FROM incoming
      JOIN artifacts source_artifacts
        ON source_artifacts.id = incoming.source_artifact_id
        AND source_artifacts.organization_id = incoming.organization_id
        AND source_artifacts.type::text = ${ArtifactType.Session}
    ),
    upserted AS (
      INSERT INTO branch_materialization_retries (
        id,
        organization_id,
        source_artifact_id,
        repository_full_name,
        branch_name,
        branch_ref,
        state,
        reason,
        attempts,
        next_attempt_at,
        claimed_at,
        claim_generation,
        created_at,
        updated_at
      )
      SELECT
        eligible.id,
        eligible.organization_id,
        eligible.source_artifact_id,
        eligible.repository_full_name,
        eligible.branch_name,
        eligible.branch_ref,
        eligible.state,
        eligible.reason,
        eligible.attempts,
        eligible.next_attempt_at,
        NULL,
        eligible.claim_generation,
        eligible.created_at,
        eligible.written_at
      FROM eligible
      WHERE TRUE
      ON CONFLICT (organization_id, source_artifact_id, repository_full_name, branch_name)
      DO UPDATE SET
        branch_ref = EXCLUDED.branch_ref,
        state = EXCLUDED.state,
        reason = EXCLUDED.reason,
        attempts = EXCLUDED.attempts,
        next_attempt_at = EXCLUDED.next_attempt_at,
        -- ISS-8229: created_at is the anchor nextRetryAt measures MaxHorizonMs
        -- from, so it is a budget field of the CURRENT scheduling lifetime, not
        -- only an audit stamp. A revival that reset attempts but left this stale
        -- hands the row a spent horizon: the first retryable drain result would
        -- compute a null next attempt and dead-letter it after one attempt. The
        -- incoming value echoes the stored one for every write that is not a
        -- revival, so this assignment moves the anchor exactly when the
        -- lifetime restarts.
        created_at = EXCLUDED.created_at,
        claimed_at = NULL,
        claim_generation = branch_materialization_retries.claim_generation + EXCLUDED.claim_generation,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    )
    SELECT
      eligible.identity_key AS "identityKey",
      upserted.id AS "retryId",
      upserted.organization_id AS "organizationId",
      upserted.source_artifact_id AS "sourceArtifactId",
      upserted.repository_full_name AS "repositoryFullName",
      upserted.branch_name AS "branchName",
      upserted.attempts,
      eligible.outcome
    FROM upserted
    JOIN eligible
      ON eligible.organization_id = upserted.organization_id
      AND eligible.source_artifact_id = upserted.source_artifact_id
      AND eligible.repository_full_name = upserted.repository_full_name
      AND eligible.branch_name = upserted.branch_name
  `);
}

function buildBranchRetryBulkWriteRow(
  entry: PreparedBranchRetryEnqueue,
  existing: ExistingBranchRetryRow | undefined,
  aggregate: BranchRefAggregate,
  now: Date
): BranchRetryBulkWriteRow | null {
  const terminal =
    existing?.state === BranchMaterializationRetryState.Terminal ||
    existing?.state === BranchMaterializationRetryState.DeadLetter;
  // ISS-8229: ISS-8186's per-session budget routes an accepted session's whole
  // branch tail through this store instead of the inline path, which re-judged
  // fresh authority every sync. So a reason recorded once at drain time now
  // decides the identity forever, and a reason that only ever described the
  // WORLD must not outlive the condition it named. Condition-terminal rows
  // revive on the next payload; identity-terminal rows stay refused.
  const canRevive =
    terminal &&
    isRevivableBranchMaterializationTerminalReason(existing?.reason);
  if (terminal && !canRevive) {
    return null;
  }

  const invalidatesClaim =
    existing?.state === BranchMaterializationRetryState.Claimed || canRevive;
  const outcome = branchRetryBulkWriteOutcome(existing, canRevive);

  return {
    key: entry.key,
    retryId: existing?.retryId ?? uuidv7(),
    input: entry.input,
    aggregate,
    outcome,
    attempts: canRevive || !existing ? 0 : existing.attempts,
    // The retry horizon is the SECOND budget, and resetting only `attempts`
    // leaves it spent: `nextRetryAt` measures MaxHorizonMs from `created_at`, so
    // a revived row older than the horizon dead-letters on its first retryable
    // drain result. A revival starts a new scheduling lifetime, so it restarts
    // both. Every other write echoes the stored anchor back unchanged.
    createdAt: canRevive || !existing ? now : existing.createdAt,
    nextAttemptAt: invalidatesClaim
      ? nextInitialAttemptAt(now)
      : (existing?.nextAttemptAt ?? nextInitialAttemptAt(now)),
    claimGeneration: invalidatesClaim ? 1 : 0,
  };
}

function branchRetryBulkWriteOutcome(
  existing: ExistingBranchRetryRow | undefined,
  canRevive: boolean
): EnqueueRow["outcome"] {
  if (!existing) {
    return "scheduled";
  }
  if (canRevive) {
    return "revived";
  }
  return "already_scheduled";
}

function branchRetryIdentityValue(
  input: EnqueueBranchMaterializationRetryInput
): Prisma.Sql {
  return Prisma.sql`(
    CAST(${input.organizationId} AS UUID),
    CAST(${input.sourceArtifactId} AS UUID),
    CAST(${input.aggregate.repositoryFullName} AS TEXT),
    CAST(${input.aggregate.branchName} AS TEXT)
  )`;
}

function branchRetryBulkWriteValue(
  row: BranchRetryBulkWriteRow,
  now: Date
): Prisma.Sql {
  return Prisma.sql`(
    CAST(${row.key} AS TEXT),
    CAST(${row.retryId} AS UUID),
    CAST(${row.input.organizationId} AS UUID),
    CAST(${row.input.sourceArtifactId} AS UUID),
    CAST(${row.aggregate.repositoryFullName} AS TEXT),
    CAST(${row.aggregate.branchName} AS TEXT),
    CAST(${stringifyAggregate(row.aggregate)} AS JSONB),
    CAST(${BranchMaterializationRetryState.Pending} AS TEXT),
    CAST(${row.input.reason} AS TEXT),
    CAST(${row.attempts} AS INTEGER),
    CAST(${row.nextAttemptAt} AS TIMESTAMPTZ),
    CAST(${row.claimGeneration} AS INTEGER),
    CAST(${row.createdAt} AS TIMESTAMPTZ),
    CAST(${now} AS TIMESTAMPTZ),
    CAST(${row.outcome} AS TEXT)
  )`;
}

function retryIdentityKey(
  input: {
    organizationId: string;
    sourceArtifactId: string;
  },
  aggregate: BranchRefAggregate
): string {
  return JSON.stringify([
    input.organizationId,
    input.sourceArtifactId,
    aggregate.repositoryFullName,
    aggregate.branchName,
  ]);
}

function retryIdentityKeyFromExisting(
  existing: ExistingBranchRetryRow
): string {
  return JSON.stringify([
    existing.organizationId,
    existing.sourceArtifactId,
    existing.repositoryFullName,
    existing.branchName,
  ]);
}

function mergeStoredAggregate(
  existingBranchRef: unknown,
  incoming: BranchRefAggregate
): BranchRefAggregate {
  const existing = parseBranchMaterializationRetryAggregate(existingBranchRef);
  return existing
    ? mergeBranchRefAggregatesReplacingPullRequestRefs(existing, incoming)
    : incoming;
}

function nextInitialAttemptAt(now: Date): Date {
  return new Date(now.getTime() + BranchMaterializationRetryPolicy.BaseDelayMs);
}

function stringifyAggregate(aggregate: BranchRefAggregate): string {
  return JSON.stringify({
    ...aggregate,
    branchLifecycleEvents: aggregate.branchLifecycleEvents ?? [],
  });
}

function branchMaterializationRetryOrgExclusion(
  organizationIds: readonly string[]
): Prisma.Sql {
  if (organizationIds.length === 0) {
    return Prisma.empty;
  }
  const castedIds = organizationIds.map(
    (organizationId) => Prisma.sql`CAST(${organizationId} AS UUID)`
  );
  return Prisma.sql`AND retries.organization_id NOT IN (${Prisma.join(castedIds)})`;
}

const branchMaterializationRetryTimestampSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "Expected a parseable timestamp",
  });

const branchMaterializationRetryPayloadSchema = z.object({
  repositoryFullName: z.string().min(1),
  branchName: z.string().min(1),
  method: z.string().min(1).max(200),
  relation: z.enum([
    ArtifactRefRelation.Input,
    ArtifactRefRelation.Output,
    ArtifactRefRelation.Referenced,
    ArtifactRefRelation.Created,
    ArtifactRefRelation.Reviewed,
    ArtifactRefRelation.Workspace,
  ]),
  observedAt: branchMaterializationRetryTimestampSchema.optional(),
  pushedAt: branchMaterializationRetryTimestampSchema.optional(),
  // ISS-8148: the push-EVIDENCE bit, independent of the push-TIME above.
  // Optional so a row enqueued before this field existed still parses; absent
  // reads as "no push observed", which is the pre-ISS-8148 behavior.
  pushObserved: z.boolean().optional(),
  // ISS-8186: the same-batch PR vouch, persisted so a deferred identity reaches
  // the drain with the evidence that made it eligible. Optional for the same
  // reason `pushObserved` is — a row enqueued before this field existed still
  // parses, and absent reads as "no PR named this branch", the prior behaviour.
  pullRequestObserved: z.boolean().optional(),
  // Optional for version-skewed rows; PR-head-only retries use false so the
  // drain does not rewrite them as independent Branch evidence.
  branchRefObserved: z.boolean().optional(),
  prRefs: z.array(persistedSessionPrRefSchema).optional(),
  branchLifecycleEvents: z
    .array(
      z.object({
        kind: z.enum([
          BranchLifecycleBoundaryKind.SessionStart,
          BranchLifecycleBoundaryKind.BranchWrite,
          BranchLifecycleBoundaryKind.PrRaised,
          BranchLifecycleBoundaryKind.ReviewFeedback,
          BranchLifecycleBoundaryKind.ReadOnlyReference,
          BranchLifecycleBoundaryKind.UnknownEvidence,
          BranchLifecycleBoundaryKind.SessionEnd,
        ]),
        observedAt: branchMaterializationRetryTimestampSchema.optional(),
        evidenceId: z.string().min(1).max(500).optional(),
      })
    )
    .default([]),
  directParticipation: z
    .enum([BranchParticipationKind.Wrote, BranchParticipationKind.Reviewed])
    .optional(),
  directParticipationMethod: z.string().min(1).max(200).optional(),
  directParticipationObservedAt:
    branchMaterializationRetryTimestampSchema.optional(),
  // ISS-10332: an unreadable stored priority degrades to no claim rather than
  // failing the whole row as corrupt, which would drop the branch itself.
  priority: syncedPrioritySchema,
});

type PreparedBranchRetryEnqueue = {
  key: string;
  input: EnqueueBranchMaterializationRetryInput;
};

type BranchRetryBulkWriteRow = {
  key: string;
  retryId: string;
  input: EnqueueBranchMaterializationRetryInput;
  aggregate: BranchRefAggregate;
  outcome: EnqueueRow["outcome"];
  attempts: number;
  createdAt: Date;
  nextAttemptAt: Date;
  claimGeneration: number;
};

type ExistingBranchRetryRow = {
  retryId: string;
  organizationId: string;
  sourceArtifactId: string;
  repositoryFullName: string;
  branchName: string;
  branchRef: unknown;
  state: BranchMaterializationRetryState;
  reason: string | null;
  attempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
};

type EnqueueRow = {
  identityKey: string;
  retryId: string;
  organizationId: string;
  sourceArtifactId: string;
  repositoryFullName: string;
  branchName: string;
  attempts: number;
  outcome: "scheduled" | "already_scheduled" | "revived";
};

type WriteGuardRow = {
  validationReason: BranchMaterializationRetryTerminalReason | null;
  branchRef: unknown;
  projectId: string | null;
};

/** ISS-8186: chunk retry writes under the conservative Postgres bind ceiling. */
const BRANCH_RETRY_IDENTITY_BINDS_PER_ROW = 4;
const BRANCH_RETRY_WRITE_BINDS_PER_ROW = 15;
const BRANCH_RETRY_IDENTITY_CHUNK_SIZE = Math.floor(
  POSTGRES_MAX_BIND_PARAMETERS / BRANCH_RETRY_IDENTITY_BINDS_PER_ROW / 2
);
/**
 * Exported so a test can size a fixture at "more than one statement" from the
 * real chunk width instead of restating the arithmetic — a fixture that silently
 * stopped spanning statements would otherwise keep asserting nothing.
 */
export const BRANCH_RETRY_WRITE_CHUNK_SIZE = Math.floor(
  POSTGRES_MAX_BIND_PARAMETERS / BRANCH_RETRY_WRITE_BINDS_PER_ROW / 2
);

/**
 * Total order over the advisory-lock identity, matching the column order the
 * lock statement's own `ORDER BY` uses. See {@link lockBranchRetryIdentities}
 * for why the sort has to span the whole set rather than each chunk.
 */
function compareBranchRetryIdentity(
  left: EnqueueBranchMaterializationRetryInput,
  right: EnqueueBranchMaterializationRetryInput
): number {
  return (
    left.organizationId.localeCompare(right.organizationId) ||
    left.sourceArtifactId.localeCompare(right.sourceArtifactId) ||
    left.aggregate.repositoryFullName.localeCompare(
      right.aggregate.repositoryFullName
    ) ||
    left.aggregate.branchName.localeCompare(right.aggregate.branchName)
  );
}
