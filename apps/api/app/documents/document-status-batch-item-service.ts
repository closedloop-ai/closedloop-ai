import {
  BatchItemFailureCode,
  type BatchItemResult,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import type { ArtifactStatus } from "@repo/api/src/types/document";
import type { DocumentStatusTransition } from "@repo/api/src/types/document-status-mutation";
import { withDb } from "@repo/database";
import { writeStatusChanges } from "./document-status-batch-write";
import {
  collectInvalidStatuses,
  collectStaleStatuses,
  type LockedDocumentRow,
  lockDocumentRows,
} from "./document-status-mutation-service";

export type DocumentStatusBatchItemSuccess = {
  /**
   * One result for EVERY distinct requested id. The route re-keys this into
   * request order with `orderBatchResults`, which reports an id this map omits
   * as `outcome_unknown` — so the loop below must never skip one.
   */
  resultsById: Map<string, BatchItemResult>;
  changedIds: string[];
  transitions: DocumentStatusTransition[];
};

/**
 * The per-item sibling behind `POST /documents/batch-update-status/v2`
 * (ISS-9464).
 *
 * Shares the whole write with `documentStatusMutationService.batchUpdateStatus`
 * rather than restating it: the same `lockDocumentRows`, the same collectors and
 * the same `writeStatusChanges`, so the change rule and the write predicate have
 * one home. Only the fold differs. v1 folds the first non-empty problem set into
 * one whole-batch error, so a single bad id refuses every good one. This
 * classifies each id and writes the eligible subset.
 *
 * Item-level problems are never an error `Result`: the route has no envelope
 * failure to answer for this body beyond a parse error, so the success shape is
 * returned directly rather than wrapped in a branch nothing can take.
 */
export const documentStatusBatchItemService = {
  batchUpdateStatus(
    documentIds: string[],
    status: ArtifactStatus,
    organizationId: string,
    expectedStatusById?: Record<string, string>
  ): Promise<DocumentStatusBatchItemSuccess> {
    const uniqueIds = [...new Set(documentIds)];

    return withDb.tx(async (tx): Promise<DocumentStatusBatchItemSuccess> => {
      const lockedRows = await lockDocumentRows(tx, uniqueIds, organizationId);
      const rowsById = new Map(lockedRows.map((row) => [row.id, row]));
      const invalidById = new Map(
        collectInvalidStatuses(lockedRows, status).map((invalid) => [
          invalid.documentId,
          invalid,
        ])
      );
      const staleById = new Map(
        collectStaleStatuses(lockedRows, expectedStatusById, status).map(
          (stale) => [stale.documentId, stale]
        )
      );

      const resultsById = new Map<string, BatchItemResult>();
      const appliedRows: LockedDocumentRow[] = [];
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
        // Subtype validity before staleness, matching v1's set order: a row
        // that is both is reported as the problem a retry cannot fix.
        const invalid = invalidById.get(id);
        if (invalid) {
          resultsById.set(
            id,
            batchItemFailed(
              id,
              BatchItemFailureCode.InvalidStatusForSubtype,
              invalid
            )
          );
          continue;
        }
        const stale = staleById.get(id);
        if (stale) {
          resultsById.set(
            id,
            batchItemFailed(id, BatchItemFailureCode.StaleStatus, stale)
          );
          continue;
        }

        resultsById.set(id, batchItemApplied(id));
        appliedRows.push(row);
      }

      const { transitions, changedIds } = await writeStatusChanges(
        tx,
        appliedRows,
        status,
        organizationId
      );

      return { resultsById, changedIds, transitions };
    });
  },
};
