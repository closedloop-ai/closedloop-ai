import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type { PersistedSessionPrRef } from "@repo/api/src/types/session-artifact-link";
import { sessionPrIdentityKey } from "@repo/api/src/types/session-artifact-link";
import { Prisma, type TransactionClient } from "@repo/database";
import {
  BranchMaterializationRetryState,
  parseBranchMaterializationRetryAggregate,
} from "./branch-materialization-retry";
import {
  type BranchRefAggregate,
  mergePersistedSessionPrRefs,
  normalizeBranchRefAggregatePrRefs,
} from "./branch-ref-aggregate";
import type { SessionPrRefWithMethod } from "./prose-pr-refs";

type RetryRow = {
  id: string;
  state: string;
  branchRef: unknown;
};

type RetryRewrite = {
  id: string;
  state: string;
  aggregate: BranchRefAggregate;
};

const RETRY_PRUNING_PAGE_SIZE = 250;

/**
 * Keep PR-head retry rows in sync with the fresh PR replacement set that owns
 * them. Independent Branch evidence survives; stale PR identity does not.
 */
export async function pruneStalePullRequestHeadBranchRetriesTx(
  tx: TransactionClient,
  input: {
    organizationId: string;
    sourceArtifactId: string;
    currentPrRefs: readonly SessionPrRefWithMethod[];
  },
  now = new Date()
): Promise<void> {
  const retainedByIdentity = currentPersistedPrRefsByIdentity(
    input.currentPrRefs
  );

  let afterId: string | undefined;
  for (;;) {
    const rows = await readSessionBranchRetryRowsForPruningTx(
      tx,
      input,
      afterId
    );

    const { deleteIds, rewrites } = planRetryPageWrites(
      rows,
      retainedByIdentity
    );
    if (deleteIds.length > 0) {
      await deleteRetryRowsTx(tx, input, deleteIds);
    }
    if (rewrites.length > 0) {
      await rewriteRetryRowsTx(tx, input, rewrites, now);
    }

    if (rows.length < RETRY_PRUNING_PAGE_SIZE) {
      break;
    }
    afterId = rows.at(-1)!.id;
  }
}

function currentPersistedPrRefsByIdentity(
  refs: readonly SessionPrRefWithMethod[]
): Map<string, PersistedSessionPrRef> {
  const merged = mergePersistedSessionPrRefs(
    refs.map((ref) => ({
      repositoryFullName: normalizeRepoFullName(ref.repositoryFullName),
      prNumber: ref.prNumber,
      relationTypes: [ref.relationType],
      ...(ref.method ? { method: ref.method } : {}),
    }))
  );
  return new Map(
    merged.map((ref) => [
      sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber),
      ref,
    ])
  );
}

function isPrHeadRetryAggregate(aggregate: BranchRefAggregate): boolean {
  return (
    aggregate.pullRequestObserved === true ||
    aggregate.branchRefObserved === false ||
    (aggregate.prRefs ?? []).length > 0
  );
}

function pruneAggregatePrRefs(
  aggregate: BranchRefAggregate,
  retainedByIdentity: ReadonlyMap<string, PersistedSessionPrRef>
): BranchRefAggregate | null {
  if (!hasPrRefs(aggregate) && aggregate.branchRefObserved !== false) {
    return normalizeBranchRefAggregatePrRefs(aggregate);
  }
  const retainedRefs = mergePersistedSessionPrRefs(
    (aggregate.prRefs ?? []).flatMap((ref) => {
      const retained = retainedByIdentity.get(
        sessionPrIdentityKey(
          normalizeRepoFullName(ref.repositoryFullName),
          ref.prNumber
        )
      );
      return retained ? [retained] : [];
    })
  );
  if (retainedRefs.length > 0) {
    return normalizeBranchRefAggregatePrRefs({
      ...aggregate,
      pullRequestObserved: true,
      prRefs: retainedRefs,
    });
  }
  if (aggregate.branchRefObserved === false) {
    return null;
  }
  const preserved = { ...aggregate };
  Reflect.deleteProperty(preserved, "pullRequestObserved");
  Reflect.deleteProperty(preserved, "prRefs");
  return normalizeBranchRefAggregatePrRefs(preserved);
}

async function rewriteRetryRowsTx(
  tx: TransactionClient,
  input: {
    organizationId: string;
    sourceArtifactId: string;
  },
  rewrites: readonly RetryRewrite[],
  now: Date
): Promise<void> {
  const values = Prisma.join(
    rewrites.map(
      (rewrite) => Prisma.sql`(
        CAST(${rewrite.id} AS UUID),
        CAST(${JSON.stringify(rewrite.aggregate)} AS JSONB),
        CAST(${retryRewriteState(rewrite.state)} AS VARCHAR),
        CAST(${retryRewriteClaimGeneration(rewrite.state)} AS INTEGER)
      )`
    )
  );
  await tx.$executeRaw(Prisma.sql`
    UPDATE branch_materialization_retries AS retries
    SET branch_ref = rewrite.branch_ref,
        state = rewrite.state,
        claimed_at = NULL,
        claim_generation = retries.claim_generation + rewrite.claim_generation_delta,
        updated_at = ${now}
    FROM (VALUES ${values})
      AS rewrite(id, branch_ref, state, claim_generation_delta)
    WHERE retries.id = rewrite.id
      AND retries.organization_id = CAST(${input.organizationId} AS UUID)
      AND retries.source_artifact_id = CAST(${input.sourceArtifactId} AS UUID)
  `);
}

async function deleteRetryRowsTx(
  tx: TransactionClient,
  input: {
    organizationId: string;
    sourceArtifactId: string;
  },
  ids: readonly string[]
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM branch_materialization_retries
    WHERE id = ANY(ARRAY[${Prisma.join(ids)}]::uuid[])
      AND organization_id = CAST(${input.organizationId} AS UUID)
      AND source_artifact_id = CAST(${input.sourceArtifactId} AS UUID)
  `);
}

function readSessionBranchRetryRowsForPruningTx(
  tx: TransactionClient,
  input: {
    organizationId: string;
    sourceArtifactId: string;
  },
  afterId?: string
): Promise<RetryRow[]> {
  const keysetPredicate = afterId
    ? Prisma.sql`AND retries.id > CAST(${afterId} AS UUID)`
    : Prisma.empty;

  return tx.$queryRaw<RetryRow[]>(Prisma.sql`
    SELECT
      retries.id,
      retries.state,
      retries.branch_ref AS "branchRef"
    FROM branch_materialization_retries retries
    WHERE retries.organization_id = CAST(${input.organizationId} AS UUID)
      AND retries.source_artifact_id = CAST(${input.sourceArtifactId} AS UUID)
      ${keysetPredicate}
    ORDER BY retries.id ASC
    LIMIT ${RETRY_PRUNING_PAGE_SIZE}
    FOR UPDATE OF retries
  `);
}

function hasPrRefs(aggregate: BranchRefAggregate): boolean {
  return aggregate.prRefs !== undefined && aggregate.prRefs.length > 0;
}

function retryRewriteState(state: string): string {
  return state === BranchMaterializationRetryState.Claimed
    ? BranchMaterializationRetryState.Pending
    : state;
}

function retryRewriteClaimGeneration(state: string): number {
  return state === BranchMaterializationRetryState.Claimed ? 1 : 0;
}

// One DELETE and one UPDATE per page keeps the write count inside the
// session-ingest transaction bounded by page count, not by row count.
function planRetryPageWrites(
  rows: readonly RetryRow[],
  retainedByIdentity: ReadonlyMap<string, PersistedSessionPrRef>
): { deleteIds: string[]; rewrites: RetryRewrite[] } {
  const deleteIds: string[] = [];
  const rewrites: RetryRewrite[] = [];
  for (const row of rows) {
    const aggregate = parseBranchMaterializationRetryAggregate(row.branchRef);
    if (!(aggregate && isPrHeadRetryAggregate(aggregate))) {
      continue;
    }
    const nextAggregate = pruneAggregatePrRefs(aggregate, retainedByIdentity);
    if (!nextAggregate) {
      deleteIds.push(row.id);
      continue;
    }
    if (JSON.stringify(nextAggregate) === JSON.stringify(aggregate)) {
      continue;
    }
    rewrites.push({ id: row.id, state: row.state, aggregate: nextAggregate });
  }
  return { deleteIds, rewrites };
}
