import { ArtifactType } from "@repo/api/src/types/artifact";
import type { BatchItemResult } from "@repo/api/src/types/batch-mutation-result";
import { Result, Status } from "@repo/api/src/types/result";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import {
  computeNextSortOrder,
  STACK_RANK_GAP,
} from "@/app/documents/document-sort-order";
import type { BatchProjectChange } from "@/lib/artifact-activity-capture";
import { batchResultsByFound } from "@/lib/batch-mutation-response";

export type BatchMoveDocumentsSuccess = {
  /** Every requested id, deduplicated, in request order. The wire response. */
  movedIds: string[];
  /**
   * The per-row project transition, read in the same transaction as the write
   * (ISS-9158). Internal: the route feeds it to `captureBatchProjectChange`
   * and never serializes it.
   */
  projectChanges: BatchProjectChange[];
};

/**
 * Atomic bulk document project move. Lives here rather than in
 * `document-service.ts`, which sits at the file-size grandfather ceiling —
 * the same reason `artifact-bulk-priority-service` is a neighbour.
 *
 * `batchMove` validates that all artifacts and the target project belong to
 * the user's organization: a missing target project is `Status.BadRequest`, a
 * missing document is `Status.NotFound`, the same split `batchMoveArtifacts`
 * makes. `batchMovePerItem` reports a missing document per item instead.
 * Per PRD-421 § Cross-project move: the source project's
 * `sortOrder` is discarded; each moved artifact is appended to the bottom of
 * the destination's stack rank in array order. New sortOrders are spaced by
 * `STACK_RANK_GAP` and start one gap above the destination's current MAX
 * (or `0` if the destination is empty). A `null` target files the documents
 * into no project and clears their rank, which a project-less create also
 * leaves `null` (ISS-12858).
 */
export const documentBatchMoveService = {
  batchMove(
    documentIds: string[],
    targetProjectId: string | null,
    organizationId: string
  ): Promise<Result<BatchMoveDocumentsSuccess>> {
    const uniqueIds = [...new Set(documentIds)];

    if (uniqueIds.length === 0) {
      return Promise.resolve(Result.ok({ movedIds: [], projectChanges: [] }));
    }

    return withDb.tx(async (tx): Promise<Result<BatchMoveDocumentsSuccess>> => {
      const locked = await authorizeMoveAndLockRows(
        tx,
        uniqueIds,
        targetProjectId,
        organizationId
      );

      if (!locked.ok) {
        return locked;
      }

      const artifacts = locked.value;

      if (artifacts.length !== uniqueIds.length) {
        return Result.err(Status.NotFound);
      }

      const projectChanges = await applyMove(
        tx,
        artifacts,
        uniqueIds,
        targetProjectId,
        organizationId
      );

      return Result.ok({ movedIds: uniqueIds, projectChanges });
    });
  },

  /**
   * The per-item sibling behind `POST /documents/batch-move/v2` (ISS-9464).
   *
   * Same lock and same write as {@link documentBatchMoveService.batchMove}; the
   * only difference is what a missing id does. v1 refuses the whole batch;
   * this moves the documents it found and reports the rest
   * `artifacts_not_found`. A target project outside the org is still an
   * envelope error, because it fails every item identically.
   */
  batchMovePerItem(
    documentIds: string[],
    targetProjectId: string | null,
    organizationId: string
  ): Promise<Result<BatchMoveDocumentsPerItemSuccess>> {
    const uniqueIds = [...new Set(documentIds)];

    if (uniqueIds.length === 0) {
      return Promise.resolve(
        Result.ok({ results: new Map(), projectChanges: [] })
      );
    }

    return withDb.tx(
      async (tx): Promise<Result<BatchMoveDocumentsPerItemSuccess>> => {
        const locked = await authorizeMoveAndLockRows(
          tx,
          uniqueIds,
          targetProjectId,
          organizationId
        );

        if (!locked.ok) {
          return locked;
        }

        const artifacts = locked.value;
        const foundIds = new Set(artifacts.map((artifact) => artifact.id));

        const results = batchResultsByFound(uniqueIds, foundIds);

        const movableIds = uniqueIds.filter((id) => foundIds.has(id));
        if (movableIds.length === 0) {
          return Result.ok({ results, projectChanges: [] });
        }

        const projectChanges = await applyMove(
          tx,
          artifacts,
          movableIds,
          targetProjectId,
          organizationId
        );

        return Result.ok({ results, projectChanges });
      }
    );
  },
};

type LockedMoveRow = { id: string; projectId: string | null };

/**
 * The before-`projectId` read is authoritative only if the row cannot move
 * between it and the UPDATE below: under READ COMMITTED an unlocked read lets
 * two concurrent moves both see project A and then record A→B and A→C, the
 * second of which never happened. Same `FOR NO KEY UPDATE`, same
 * `ORDER BY "id" ASC`, as the status and priority batches take on this table,
 * so the three cannot deadlock against each other (ISS-9440).
 */
function lockDocumentRowsForMove(
  tx: TransactionClient,
  documentIds: string[],
  organizationId: string
): Promise<LockedMoveRow[]> {
  const documentIdSql = Prisma.join(
    documentIds.map((documentId) => Prisma.sql`${documentId}::uuid`)
  );
  return tx.$queryRaw<LockedMoveRow[]>(Prisma.sql`
    SELECT "id", "project_id" AS "projectId"
    FROM "artifacts"
    WHERE "id" IN (${documentIdSql})
      AND "organization_id" = ${organizationId}::uuid
      AND "type" = ${ArtifactType.Document}::"ArtifactType"
    ORDER BY "id" ASC
    FOR NO KEY UPDATE
  `);
}

/**
 * The write half of a move, over rows {@link lockDocumentRowsForMove} has
 * ALREADY locked. Both callers lock exactly once and then decide — v1 refuses
 * the whole batch on a missing id, v2 partitions — so no path takes the lock
 * twice, and the lock order stays the one the status and priority batches take.
 *
 * `orderedIds` is the caller's request order: it decides the sortOrder sequence
 * AND which locked rows are reported, so the set written and the set reported
 * are one collection by construction rather than two arguments that happen to
 * coincide — a locked row the write did not cover is skipped, never reported as
 * a move that never happened. `lockedRows` supplies the before-`projectId` each
 * activity event needs, read under the same lock (ISS-9158), and the order they
 * are emitted in: lock order, which is what v1 emitted before this helper
 * existed and must keep emitting.
 */
async function applyMove(
  tx: TransactionClient,
  lockedRows: LockedMoveRow[],
  orderedIds: string[],
  targetProjectId: string | null,
  organizationId: string
): Promise<BatchProjectChange[]> {
  if (targetProjectId === null) {
    await tx.artifact.updateMany({
      where: {
        id: { in: orderedIds },
        organizationId,
        type: ArtifactType.Document,
      },
      data: { projectId: null, sortOrder: null },
    });
  } else {
    await writeMoveToProject(tx, orderedIds, targetProjectId, organizationId);
  }

  const writtenIds = new Set(orderedIds);
  return lockedRows
    .filter((artifact) => writtenIds.has(artifact.id))
    .map((artifact) => ({
      artifactId: artifact.id,
      before: artifact.projectId,
      after: targetProjectId,
    }));
}

async function writeMoveToProject(
  tx: TransactionClient,
  orderedIds: string[],
  targetProjectId: string,
  organizationId: string
): Promise<void> {
  const destStart = await computeNextSortOrder(
    tx,
    organizationId,
    targetProjectId
  );
  // Single `UPDATE … FROM (VALUES …)` rewrites projectId + sortOrder for
  // every moved artifact in one Postgres round-trip. Avoids the
  // interactive-transaction footgun of `Promise.all(tx.artifact.update)`,
  // which serialises on a single connection and was the pre-FEA-821
  // pattern. Same shape as `documentService.reorder`, with an extra
  // projectId column in the VALUES tuple.
  const valueRows = orderedIds.map(
    (id, index) =>
      Prisma.sql`(${id}::uuid, ${destStart + index * STACK_RANK_GAP}::int)`
  );
  await tx.$executeRaw(Prisma.sql`
    UPDATE "artifacts"
    SET "project_id" = ${targetProjectId}::uuid,
        "sort_order" = data.new_order
    FROM (VALUES ${Prisma.join(valueRows)}) AS data(id, new_order)
    WHERE "artifacts"."id" = data.id
      AND "artifacts"."organization_id" = ${organizationId}::uuid
      AND "artifacts"."type" = ${ArtifactType.Document}::"ArtifactType"
  `);
}

export type BatchMoveDocumentsPerItemSuccess = {
  /** One result per distinct requested id, keyed by id; the route orders them. */
  results: Map<string, BatchItemResult>;
  /** The project transition of the rows that MOVED — never the requested set. */
  projectChanges: BatchProjectChange[];
};

/**
 * The read half both variants share: refuse a target project outside the org,
 * then take the row lock. One copy because it is the tenant predicate — the
 * part that must not drift between the two — and because the refusal has to
 * land BEFORE the lock in both, so a caller outside the org never holds rows.
 */
async function authorizeMoveAndLockRows(
  tx: TransactionClient,
  uniqueIds: string[],
  targetProjectId: string | null,
  organizationId: string
): Promise<Result<LockedMoveRow[]>> {
  if (targetProjectId !== null) {
    const targetProject = await tx.project.findFirst({
      where: { id: targetProjectId, organizationId },
      select: { id: true },
    });

    if (!targetProject) {
      return Result.err(Status.BadRequest);
    }
  }

  return Result.ok(
    await lockDocumentRowsForMove(tx, uniqueIds, organizationId)
  );
}
