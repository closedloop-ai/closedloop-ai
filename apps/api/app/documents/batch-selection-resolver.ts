import { ArtifactType } from "@repo/api/src/types/artifact";
import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import {
  type BatchQuerySelectionError,
  BatchQuerySelectionErrorCode,
  batchQuerySelectionError,
} from "@repo/api/src/types/batch-query-selection";
import {
  type Result,
  Result as ResultHelpers,
  Status,
} from "@repo/api/src/types/result";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { resolveProjectId } from "@/lib/identifier-utils";
import { badRequestResponse, notFoundResponse } from "@/lib/route-utils";
import type { DocumentListQueryOptions } from "./custom-field-ordered-read";
import { buildDocumentListWhere } from "./document-list-query";
import {
  readDocumentListInSnapshot,
  requiresCustomFieldSnapshot,
} from "./document-list-snapshot";
import type { BatchDocumentSelection } from "./validators";

/**
 * ISS-9579 — turn a batch mutation's SELECTION into the ids it operates on.
 *
 * ISS-9575 (Cosimo Corrigan, 2026-09-16) ruled that select-all means the whole
 * matching set and that bulk actions apply server-side to it: "an action cannot
 * be implemented by iterating the rows the client happens to hold; the set is
 * defined by the filter predicate, and the predicate is what the action must
 * carry." This module is where that predicate becomes ids, and the ids never
 * cross the wire inbound.
 *
 * The population is read through {@link buildDocumentListWhere} — the one
 * builder `GET /documents` and its honest `count()` also use — so the set a
 * write touches cannot drift from the set the reader was looking at.
 */

/** A batch body that names its set one of the two legal ways. */
export type BatchSelectionBody = {
  documentIds?: string[];
  selection?: BatchDocumentSelection;
};

/** Which arm named the set, and therefore what holding it requires. */
export const BatchSelectionArm = {
  Ids: "ids",
  Query: "query",
} as const;
export type BatchSelectionArm =
  (typeof BatchSelectionArm)[keyof typeof BatchSelectionArm];

/**
 * A batch's set, resolved but NOT yet held.
 *
 * The arm is carried rather than discarded because the two are held differently
 * at the write boundary — see {@link lockBatchSelection}.
 */
export type BatchSelectionPlan = {
  arm: BatchSelectionArm;
  documentIds: string[];
};

/**
 * Resolve a batch body to the ids the mutation runs on.
 *
 * The id arm is passed through unchanged: it is already bounded by
 * `batchDocumentIdsSchema` and it is not a select-all. The query arm is
 * resolved here, refused above the ceiling, and never truncated.
 *
 * This is the PREDICATE half. The ids it returns are candidates, not the final
 * set: {@link withLockedBatchSelection} re-checks and holds them inside the
 * write transaction, which is where ISS-9579 requires the set to be fixed.
 *
 * The validator guarantees exactly one arm, so a body with neither cannot reach
 * a route; the residual branch answers the type, not a reachable request.
 */
export async function resolveBatchSelection(
  body: BatchSelectionBody,
  organizationId: string
): Promise<Result<BatchSelectionPlan, BatchQuerySelectionError>> {
  if (body.documentIds !== undefined) {
    return ResultHelpers.ok({
      arm: BatchSelectionArm.Ids,
      documentIds: body.documentIds,
    });
  }
  if (body.selection === undefined) {
    return ResultHelpers.err(
      batchQuerySelectionError(BatchQuerySelectionErrorCode.SelectionEmpty, {
        resolvedTotal: 0,
      })
    );
  }
  const resolved = await resolveQuerySelection(body.selection, organizationId);
  if (!resolved.ok) {
    return ResultHelpers.err(resolved.error);
  }
  return ResultHelpers.ok({
    arm: BatchSelectionArm.Query,
    documentIds: resolved.value,
  });
}

/**
 * Run a batch mutation on a selection this transaction HOLDS.
 *
 * ISS-9579 asks for the set to be resolved "server-side inside the mutation",
 * and ISS-10993 already put each write and its activity receipt in one
 * transaction. This is the seam where those meet: it opens that transaction,
 * fixes the set inside it, and only then hands the ids to `run`. A route that
 * writes through this helper cannot write to a row it is not holding, which is
 * the invariant eight copies of the same three lines could not carry.
 *
 * `run` receives the transaction so it can write its receipt on it, and the ids
 * in READER order — see {@link SELECTION_READ_ORDER}.
 */
export async function withLockedBatchSelection<T>(
  plan: BatchSelectionPlan,
  organizationId: string,
  run: (tx: TransactionClient, documentIds: string[]) => Promise<T>
): Promise<Result<T, BatchQuerySelectionError>> {
  return await withDb.tx(async (tx) => {
    const held = await lockBatchSelection(tx, plan, organizationId);
    if (!held.ok) {
      return ResultHelpers.err(held.error);
    }
    return ResultHelpers.ok(await run(tx, held.value));
  });
}

/**
 * Fix the set for the rest of the write transaction.
 *
 * The two arms are NOT symmetric, and collapsing them would be a regression.
 * An id the CALLER enumerated is passed through untouched: the services answer a
 * missing one with a 400 or a per-item `artifacts_not_found`, and that report is
 * the caller's own bad id — dropping it here would delete a diagnostic a client
 * relies on. An id the SERVER resolved from a filter was never named by the
 * caller, so a row a concurrent commit removed between the predicate read and
 * here must leave the set silently, not turn a select-all into a 400 naming an
 * id the caller never typed (tamsinb, whitlockk on ISS-9579).
 */
async function lockBatchSelection(
  tx: TransactionClient,
  plan: BatchSelectionPlan,
  organizationId: string
): Promise<Result<string[], BatchQuerySelectionError>> {
  if (plan.arm === BatchSelectionArm.Ids) {
    return ResultHelpers.ok(plan.documentIds);
  }
  const held = await lockSelectedDocumentRows(
    tx,
    plan.documentIds,
    organizationId
  );
  const heldIds = new Set(held.map((row) => row.id));
  const surviving = plan.documentIds.filter((id) => heldIds.has(id));
  if (surviving.length === 0) {
    return ResultHelpers.err(
      batchQuerySelectionError(BatchQuerySelectionErrorCode.SelectionEmpty, {
        resolvedTotal: 0,
      })
    );
  }
  return ResultHelpers.ok(surviving);
}

/**
 * Take a row lock on every resolved candidate.
 *
 * Same table, same `ORDER BY "id" ASC`, same `FOR NO KEY UPDATE` as
 * `lockArtifactPriorityRows` and `lockDocumentRowsForMove`, and that agreement is
 * the point: transactions taking row locks on `artifacts` in one order cannot
 * deadlock against each other, so a query-resolved batch is safe to run
 * concurrently with an id-enumerated one over an overlapping set. The services
 * re-take these same locks, which is a no-op on this transaction.
 *
 * `FOR NO KEY UPDATE` re-reads each row after acquiring its lock, so a row a
 * concurrent transaction has committed a DELETE for is absent from the result
 * rather than reported — and once the lock is held, nothing can remove it before
 * the write. The caller narrows to what came back.
 */
function lockSelectedDocumentRows(
  tx: TransactionClient,
  documentIds: string[],
  organizationId: string
): Promise<{ id: string }[]> {
  if (documentIds.length === 0) {
    return Promise.resolve([]);
  }
  const documentIdSql = Prisma.join(
    documentIds.map((documentId) => Prisma.sql`${documentId}::uuid`)
  );
  return tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id"
    FROM "artifacts"
    WHERE "id" IN (${documentIdSql})
      AND "organization_id" = ${organizationId}::uuid
      AND "type" = ${ArtifactType.Document}::"ArtifactType"
    ORDER BY "id" ASC
    FOR NO KEY UPDATE
  `);
}

async function resolveQuerySelection(
  selection: BatchDocumentSelection,
  organizationId: string
): Promise<Result<string[], BatchQuerySelectionError>> {
  const { projectId, customFieldFilters, ...listQuery } = selection.query;

  let resolvedProjectId: string | undefined;
  if (projectId) {
    const found = await resolveProjectId(projectId, organizationId);
    if (!found) {
      return ResultHelpers.err(
        batchQuerySelectionError(
          BatchQuerySelectionErrorCode.SelectionProjectNotFound,
          { reason: projectId }
        )
      );
    }
    resolvedProjectId = found;
  }

  const base = { ...listQuery, organizationId, projectId: resolvedProjectId };
  const excludedIds = selection.excludedIds ?? [];
  const customFieldParams = { customFieldFilters };

  // Mirrors `apps/api/app/documents/route.ts`: only a request carrying a
  // custom-field dimension pays the `RepeatableRead` snapshot that resolves its
  // facets. Without one there is nothing to reconcile, and the bounded read
  // below is a single statement that is already self-consistent.
  if (!requiresCustomFieldSnapshot(customFieldParams)) {
    return await readBoundedSelection(base, excludedIds, new Date());
  }

  const resolved = await readDocumentListInSnapshot(
    base,
    customFieldParams,
    (options, now) => readBoundedSelection(options, excludedIds, now)
  );
  if (!resolved.ok) {
    return ResultHelpers.err(
      batchQuerySelectionError(
        BatchQuerySelectionErrorCode.SelectionFilterRejected,
        { reason: resolved.error }
      )
    );
  }
  return resolved.value;
}

/**
 * Read the selected ids, or refuse.
 *
 * Reads ONE past the ceiling so "exactly at it" is distinguishable from "over
 * it", and refuses rather than truncating — the same construction
 * `createScopedPopulationReader` uses, for the same reason: a truncated set
 * would let a mutation report success for a population it never matched.
 *
 * The exact total is read only on the refusal path, after the verdict is
 * already decided, so the happy path costs one statement and a drift between
 * the two reads can change the number a refusal reports but never which rows a
 * write touches.
 */
async function readBoundedSelection(
  options: DocumentListQueryOptions,
  excludedIds: readonly string[],
  now: Date
): Promise<Result<string[], BatchQuerySelectionError>> {
  const where = buildSelectionWhere(options, excludedIds, now);
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where,
      select: { id: true },
      orderBy: SELECTION_READ_ORDER,
      take: BATCH_MUTATION_ENTITY_LIMIT + 1,
    })
  );
  if (rows.length > BATCH_MUTATION_ENTITY_LIMIT) {
    const resolvedTotal = await withDb((db) => db.artifact.count({ where }));
    return ResultHelpers.err(
      batchQuerySelectionError(BatchQuerySelectionErrorCode.SelectionTooLarge, {
        resolvedTotal,
      })
    );
  }
  if (rows.length === 0) {
    return ResultHelpers.err(
      batchQuerySelectionError(BatchQuerySelectionErrorCode.SelectionEmpty, {
        resolvedTotal: 0,
      })
    );
  }
  return ResultHelpers.ok(rows.map((row) => row.id));
}

/**
 * The list predicate, narrowed by the rows the reader deselected.
 *
 * `AND` rather than a spread: `buildDocumentListWhere` already emits an `id`
 * clause when custom-field facets resolved to one, and a spread would silently
 * clobber it — the selection would then widen to rows the facets had excluded.
 */
function buildSelectionWhere(
  options: DocumentListQueryOptions,
  excludedIds: readonly string[],
  now: Date
): Prisma.ArtifactWhereInput {
  const listWhere = buildDocumentListWhere(options, now);
  if (excludedIds.length === 0) {
    return listWhere;
  }
  return { AND: [listWhere, { id: { notIn: [...excludedIds] } }] };
}

/**
 * Render a selection refusal.
 *
 * `code` and `details` are what a surface branches on: `details.limit` and
 * `details.resolvedTotal` are the two numbers a reader needs to narrow a
 * selection, stated rather than folded into the sentence. The sentence itself
 * is a server diagnostic in the same register as the sibling batch routes', not
 * a label — a surface renders its own approved copy off the code.
 */
export function batchSelectionErrorResponse(error: BatchQuerySelectionError) {
  const metadata = { code: error.code, details: error.details };
  if (error.status === Status.NotFound) {
    return notFoundResponse("Project", metadata);
  }
  return badRequestResponse(error.message, metadata);
}

/**
 * The order `GET /documents` publishes — `document-list-read.ts`, `createdAt`
 * desc with an `id` tiebreak so two rows sharing a millisecond cannot swap.
 *
 * Load-bearing rather than cosmetic (whitlockk on ISS-9579): `applyMove` assigns
 * destination stack ranks from the resolved array's order
 * (`document-batch-move-service.ts` — `orderedIds` "decides the sortOrder
 * sequence"), so without this PostgreSQL's physical row order would decide where
 * a reader's rows land in the destination. Adopted rather than chosen: the
 * selection schema omits `customFieldSortId`/`customFieldSortDir`, so this is
 * the only order any expressible selection can have been read in.
 */
const SELECTION_READ_ORDER: Prisma.ArtifactOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];
