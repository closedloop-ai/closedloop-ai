/**
 * Atomic bulk artifact priority writes (ISS-9094), with the optimistic guard
 * added by ISS-9440.
 *
 * Lives here rather than in `document-service.ts`, which owns document CRUD
 * and sits at the file-size grandfather ceiling — the same reason
 * `artifact-bulk-rank-service` is a neighbour and not a method.
 *
 * Simpler than the status batch on purpose: priority is ONE vocabulary for
 * every subtype, so unlike status there is no per-subtype validity check to
 * make. What it keeps from that path is the `changedIds` split, because the
 * activity feed must not record a no-op re-apply as a change, and it now
 * answers with the same structured `code`/`details` envelope so a client
 * branches on one error contract across both v1 batch routes.
 *
 * TRANSACTION. Each write runs in one `withDb.tx`, which JOINS an ambient
 * transaction without opening a savepoint. Since ISS-10993 every entry point
 * holds one open — the two `batch-update-priority` routes and the
 * single-artifact `PATCH /agent-sessions/[id]` and `PATCH /branches/[id]` arms
 * behind {@link artifactBulkPriorityService.updatePriority} each wrap the write
 * and its activity receipt in one transaction — so this joins the CALLER's and
 * is no longer the outermost.
 *
 * What keeps that safe is an invariant a later edit must preserve: every
 * rejection below is decided from the locking read, BEFORE this service issues
 * any write. A returned failure therefore leaves the caller's transaction with
 * nothing of ours to undo. A rejection added after
 * {@link writePriorityChanges} would not have that property — a returned error
 * does not roll a JOINED transaction back, so it would have to throw.
 *
 * ONE WRITER, THREE ARTIFACT TYPES (ISS-10332). `Artifact.priority` is the same
 * column on every type, so Document, Branch and Session priorities are written
 * here. The TYPE rides in both the lock predicate and the write predicate, and
 * each entry point names exactly one: the document batches stay DOCUMENT-only,
 * so a session id posted to them is still an unknown id, and a document id
 * sent to the sessions route is a 404.
 *
 * In `batchUpdatePriority` an unknown id is a caller mistake, so it comes back
 * as a `Result` failure carrying a 400 rather than as a throw the route would
 * render as a 500; `batchUpdatePriorityPerItem` reports it against that item
 * and still writes the rest.
 *
 * WHY THE ROWS ARE LOCKED (ISS-9440). The guard has to be evaluated against a
 * value that cannot move before the write, and two cheaper designs do not give
 * that. Comparing against an unlocked read is advisory only — under READ
 * COMMITTED a commit landing between the read and the `updateMany` is visible to
 * the `updateMany`, so the guard would clobber exactly the write it exists to
 * protect. Carrying each expectation into its own `updateMany` predicate fixes
 * that but replaces one statement with one per distinct expected value, and the
 * order those run in is derived from the caller's map: two concurrent batches
 * over an overlapping selection can lock the same rows in opposite order and
 * deadlock, which Postgres reports as `40P01` and this route would render as an
 * unclassified 500 rather than the retryable 409 the feature exists to give.
 * A single `FOR NO KEY UPDATE` over every target row, `ORDER BY "id" ASC`,
 * closes both: the comparison below is authoritative, and the canonical order is
 * the SAME one `document-status-mutation-service.lockDocumentRows` uses on this
 * table, so the two batch routes cannot deadlock against each other either.
 *
 * WHY THE PRIOR VALUES COME BACK FROM HERE (ISS-9094 review). The activity
 * feed records a transition, so it needs each row's priority from BEFORE the
 * write. Reading it in the route, ahead of this call, put the read outside
 * this transaction: an update committing in between made the feed record a
 * value that was already stale, and on the `URGENT` path that is precisely the
 * transition someone is auditing. The locked read that decides `changedIds`
 * already selects `priority`, so the prior values ride back with the result and
 * no second read exists to skew.
 */

import {
  type ArtifactPriorityMutationError,
  ArtifactPriorityMutationErrorCode,
  type ArtifactPriorityMutationStalePriority,
  type ExpectedPriorityById,
  stalePriorityConflict,
} from "@repo/api/src/types/artifact-priority-mutation";
import {
  BatchItemFailureCode,
  type BatchItemResult,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import type { Priority } from "@repo/api/src/types/common";
import { isStaleExpectation } from "@repo/api/src/types/optimistic-write-guard";
import type { Result as ResultType } from "@repo/api/src/types/result";
import { Result, Status } from "@repo/api/src/types/result";
import {
  ArtifactType,
  Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { isUuid } from "@/lib/is-uuid";

/**
 * The artifact types whose priority this service writes. A closed union rather
 * than `ArtifactType`, so a route cannot hand it a type nobody ruled on.
 */
export type PriorityWritableArtifactType =
  | typeof ArtifactType.DOCUMENT
  | typeof ArtifactType.BRANCH
  | typeof ArtifactType.SESSION;

export type UpdateArtifactPriorityInput = {
  artifactId: string;
  artifactType: PriorityWritableArtifactType;
  organizationId: string;
  /** `null` CLEARS the priority. */
  priority: Priority | null;
  /**
   * ABSENT ≠ NULL, as in `ExpectedPriorityById`: `undefined` is unguarded
   * last-write-wins, `null` asserts the artifact currently holds no priority.
   */
  expectedPriority?: Priority | null;
};

export type UpdateArtifactPrioritySuccess = {
  changed: boolean;
  /** The value read under the lock, before this write. */
  beforePriority: Priority | null;
};

export type BulkPrioritySuccess = {
  updatedIds: string[];
  changedIds: string[];
  /**
   * Prior priority for each id in `changedIds`, read in the same transaction
   * as the write. A key is present for every changed id; its value is null
   * when the artifact had no priority, because unset -> URGENT is a real
   * transition the feed must be able to state.
   */
  beforePriorities: Map<string, Priority | null>;
};

/**
 * `priority` is the `Priority` Postgres enum, so the column cannot hold an
 * off-vocabulary string and the row type says so — a `string | null` here is
 * what forces `as Priority` casts back at the call sites.
 */
type LockedPriorityRow = { id: string; priority: Priority | null };

export const artifactBulkPriorityService = {
  /**
   * Set one priority on many artifacts. Returns every id the caller asked for,
   * the subset that actually moved, and each moved row's prior value. Rejects
   * the whole batch if any id is missing from the organization, or if any
   * guarded row no longer holds the priority the caller expected, rather than
   * silently writing a subset.
   */
  batchUpdatePriority(
    documentIds: string[],
    priority: Priority,
    organizationId: string,
    expectedPriorityById?: ExpectedPriorityById
  ): Promise<ResultType<BulkPrioritySuccess, ArtifactPriorityMutationError>> {
    const uniqueIds = [...new Set(documentIds)];

    return withDb.tx(
      async (
        tx
      ): Promise<
        ResultType<BulkPrioritySuccess, ArtifactPriorityMutationError>
      > => {
        const lockedRows = await lockArtifactPriorityRows(
          tx,
          uniqueIds,
          organizationId,
          ArtifactType.DOCUMENT
        );

        const foundIds = new Set(lockedRows.map((row) => row.id));
        const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
        if (missingIds.length > 0) {
          // Nothing has been written yet, so committing this read-only
          // transaction is harmless and the caller gets its 400.
          return Result.err(missingArtifactsFailure(missingIds));
        }

        const stalePriorities = collectStalePriorities(
          lockedRows,
          expectedPriorityById,
          priority
        );
        if (stalePriorities.length > 0) {
          return Result.err(stalePriorityConflict(stalePriorities));
        }

        const rowsById = new Map(lockedRows.map((row) => [row.id, row]));
        const requestedRows = uniqueIds.flatMap((id): LockedPriorityRow[] => {
          const row = rowsById.get(id);
          return row ? [row] : [];
        });
        const { changedIds, beforePriorities } = await writePriorityChanges(
          tx,
          requestedRows,
          priority,
          organizationId,
          ArtifactType.DOCUMENT
        );

        return Result.ok({
          updatedIds: uniqueIds,
          changedIds,
          beforePriorities,
        });
      }
    );
  },

  /**
   * The per-item sibling behind `POST /documents/batch-update-priority/v2`
   * (ISS-9464).
   *
   * Shares the whole write with
   * {@link artifactBulkPriorityService.batchUpdatePriority} rather than
   * restating it: the same `lockArtifactPriorityRows`, the same
   * `collectStalePriorities` and the same `writePriorityChanges`, so the change
   * rule and the write predicate have one home. Only the fold differs: v1
   * refuses the whole batch on the first non-empty problem set, this writes the
   * eligible subset and reports the rest item by item. No envelope failure
   * exists for this body beyond a parse error, so the success shape comes back
   * directly rather than in a `Result`.
   */
  batchUpdatePriorityPerItem(
    documentIds: string[],
    priority: Priority,
    organizationId: string,
    expectedPriorityById?: ExpectedPriorityById
  ): Promise<BulkPriorityPerItemSuccess> {
    const uniqueIds = [...new Set(documentIds)];

    return withDb.tx(async (tx): Promise<BulkPriorityPerItemSuccess> => {
      const lockedRows = await lockArtifactPriorityRows(
        tx,
        uniqueIds,
        organizationId,
        ArtifactType.DOCUMENT
      );
      const rowsById = new Map(lockedRows.map((row) => [row.id, row]));
      const staleById = new Map(
        collectStalePriorities(lockedRows, expectedPriorityById, priority).map(
          (stale) => [stale.documentId, stale]
        )
      );

      const resultsById = new Map<string, BatchItemResult>();
      const appliedRows: LockedPriorityRow[] = [];
      for (const id of uniqueIds) {
        const row = rowsById.get(id);
        if (!row) {
          // No `details`: the only datum a missing id has is the id, which is
          // already on the result (ISS-9464, Milestone 3).
          resultsById.set(
            id,
            batchItemFailed(id, BatchItemFailureCode.ArtifactsNotFound)
          );
          continue;
        }
        const stale = staleById.get(id);
        if (stale) {
          resultsById.set(
            id,
            batchItemFailed(id, BatchItemFailureCode.StalePriority, stale)
          );
          continue;
        }

        resultsById.set(id, batchItemApplied(id));
        appliedRows.push(row);
      }

      const { changedIds, beforePriorities } = await writePriorityChanges(
        tx,
        appliedRows,
        priority,
        organizationId,
        ArtifactType.DOCUMENT
      );

      return { resultsById, changedIds, beforePriorities };
    });
  },

  /**
   * Set or clear ONE artifact's priority (ISS-10332) — the Session and Branch
   * write. The same lock, guard and write as the batches above, over one row.
   *
   * An id that is absent, in another organization, or of a different artifact
   * type is indistinguishable here on purpose and answers 404: the type is part
   * of the predicate, so the sessions route cannot write a branch's priority.
   */
  updatePriority(
    input: UpdateArtifactPriorityInput
  ): Promise<
    ResultType<UpdateArtifactPrioritySuccess, ArtifactPriorityMutationError>
  > {
    const { artifactId, artifactType, organizationId, priority } = input;
    // The id is a route segment; the `::uuid` cast below would turn a malformed
    // one into a Postgres error and a 500.
    if (!isUuid(artifactId)) {
      return Promise.resolve(Result.err(artifactNotFoundFailure(artifactId)));
    }

    return withDb.tx(
      async (
        tx
      ): Promise<
        ResultType<UpdateArtifactPrioritySuccess, ArtifactPriorityMutationError>
      > => {
        const lockedRows = await lockArtifactPriorityRows(
          tx,
          [artifactId],
          organizationId,
          artifactType
        );
        const [row] = lockedRows;
        if (!row) {
          return Result.err(artifactNotFoundFailure(artifactId));
        }

        const stalePriorities = collectStalePriorities(
          lockedRows,
          input.expectedPriority === undefined
            ? undefined
            : { [artifactId]: input.expectedPriority },
          priority
        );
        if (stalePriorities.length > 0) {
          return Result.err(stalePriorityConflict(stalePriorities));
        }

        const { changedIds } = await writePriorityChanges(
          tx,
          lockedRows,
          priority,
          organizationId,
          artifactType
        );
        return Result.ok({
          changed: changedIds.length > 0,
          beforePriority: row.priority,
        });
      }
    );
  },
};

/**
 * Rows whose caller-supplied expectation no longer matches what is persisted.
 *
 * `Object.hasOwn`, not a truthiness test: an id mapped to `null` is GUARDED —
 * the caller asserted the artifact holds no priority — while an id the map does
 * not mention is unguarded and keeps last-write-wins for an older client.
 *
 * A row already holding `priority` is never stale (ISS-9486 ruling 2), so a
 * retried write does not conflict with its own earlier success.
 */
function collectStalePriorities(
  rows: LockedPriorityRow[],
  expectedPriorityById: ExpectedPriorityById | undefined,
  priority: Priority | null
): ArtifactPriorityMutationStalePriority[] {
  if (!expectedPriorityById) {
    return [];
  }

  return rows.flatMap((row): ArtifactPriorityMutationStalePriority[] => {
    if (!Object.hasOwn(expectedPriorityById, row.id)) {
      return [];
    }
    const expectedPriority = expectedPriorityById[row.id];
    return isStaleExpectation(row.priority, priority, expectedPriority)
      ? [
          {
            documentId: row.id,
            currentPriority: row.priority,
            expectedPriority,
          },
        ]
      : [];
  });
}

/**
 * Lock every target row for the rest of the transaction, in id order.
 *
 * Mirrors `document-status-mutation-service.lockDocumentRows` — same table, same
 * `ORDER BY "id" ASC`, same lock mode — and that agreement is the point rather
 * than duplication nobody noticed: two transactions that take row locks on one
 * table in the same order cannot deadlock against each other, so the priority
 * batch and the status batch are safe to run concurrently over an overlapping
 * selection. The projections differ (`priority` here, `status`/`subtype` there),
 * which is why they are two statements and not one.
 */
function lockArtifactPriorityRows(
  tx: TransactionClient,
  documentIds: string[],
  organizationId: string,
  artifactType: PriorityWritableArtifactType
): Promise<LockedPriorityRow[]> {
  if (documentIds.length === 0) {
    return Promise.resolve([]);
  }
  const documentIdSql = Prisma.join(
    documentIds.map((documentId) => Prisma.sql`${documentId}::uuid`)
  );

  return tx.$queryRaw<LockedPriorityRow[]>(Prisma.sql`
    SELECT "id", "priority"
    FROM "artifacts"
    WHERE "id" IN (${documentIdSql})
      AND "organization_id" = ${organizationId}::uuid
      AND "type" = ${artifactType}::"ArtifactType"
      ${detailRowPredicate(artifactType)}
    ORDER BY "id" ASC
    FOR NO KEY UPDATE
  `);
}

function missingArtifactsFailure(
  missingIds: string[]
): ArtifactPriorityMutationError {
  return {
    status: Status.BadRequest,
    code: ArtifactPriorityMutationErrorCode.ArtifactsNotFound,
    message: `Invalid artifact IDs: ${missingIds.join(", ")} not found in organization`,
    details: {
      missingDocuments: missingIds.map((documentId) => ({ documentId })),
    },
  };
}

function artifactNotFoundFailure(
  artifactId: string
): ArtifactPriorityMutationError {
  return {
    status: Status.NotFound,
    code: ArtifactPriorityMutationErrorCode.ArtifactsNotFound,
    message: `Artifact ${artifactId} not found in organization`,
    details: { missingDocuments: [{ documentId: artifactId }] },
  };
}

export type BulkPriorityPerItemSuccess = {
  /**
   * One result for EVERY distinct requested id. The route re-keys this into
   * request order with `orderBatchResults`, which reports an id this map omits
   * as `outcome_unknown` — so the loop that fills it must never skip one.
   */
  resultsById: Map<string, BatchItemResult>;
  changedIds: string[];
  /** Prior priority for each changed id, read under the same lock as v1's. */
  beforePriorities: Map<string, Priority | null>;
};

/**
 * The rows an eligible set actually moves, plus the batch's one guarded write.
 * Shared by both methods above (ISS-9464) so neither the change rule, the prior
 * values the activity feed records, nor the write predicate can drift between
 * them.
 *
 * `rows` arrive in REQUEST order, not the lock's id order: `changedIds` and
 * `beforePriorities` become the activity feed's `changes[]`, and the caller's
 * selection order is the one a reader recognizes. A row already holding
 * `priority` is not a change, so the feed never records a no-op re-apply.
 */
async function writePriorityChanges(
  tx: TransactionClient,
  rows: LockedPriorityRow[],
  priority: Priority | null,
  organizationId: string,
  artifactType: PriorityWritableArtifactType
): Promise<{
  changedIds: string[];
  beforePriorities: Map<string, Priority | null>;
}> {
  const changed = rows.filter((row) => row.priority !== priority);
  const changedIds = changed.map((row) => row.id);
  const beforePriorities = new Map<string, Priority | null>(
    changed.map((row) => [row.id, row.priority])
  );

  if (changedIds.length > 0) {
    await tx.artifact.updateMany({
      where: { id: { in: changedIds }, organizationId, type: artifactType },
      data: { priority },
    });
  }

  return { changedIds, beforePriorities };
}

/**
 * A session or branch is its artifact PLUS its 1:1 detail row, and the detail
 * tables' `artifact_id` carries no constraint tying it to the artifact's type.
 * The sessions route reads the row back through `session_detail` after this
 * write, so locking a detail-less SESSION artifact would commit the priority
 * and then answer 404 (#7723 review). Requiring the detail row here makes that
 * artifact a not-found BEFORE anything is written. Exhaustive, so a type added
 * to {@link PriorityWritableArtifactType} has to state its own requirement.
 */
function detailRowPredicate(
  artifactType: PriorityWritableArtifactType
): Prisma.Sql {
  // Built per call, not at module scope: a suite that mocks `@repo/database`
  // without `Prisma` must still be able to import this module.
  const predicates: Record<PriorityWritableArtifactType, Prisma.Sql> = {
    [ArtifactType.DOCUMENT]: Prisma.empty,
    [ArtifactType.BRANCH]: Prisma.sql`AND EXISTS (
      SELECT 1 FROM "branch_detail"
      WHERE "branch_detail"."artifact_id" = "artifacts"."id"
    )`,
    [ArtifactType.SESSION]: Prisma.sql`AND EXISTS (
      SELECT 1 FROM "session_detail"
      WHERE "session_detail"."artifact_id" = "artifacts"."id"
    )`,
  };
  return predicates[artifactType];
}
