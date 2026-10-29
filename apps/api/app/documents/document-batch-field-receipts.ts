import type { ArtifactFieldEditField } from "@repo/api/src/types/artifact-field-edit-receipt";
import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import {
  BATCH_ITEM_APPLIED_STATUS,
  type BatchItemResult,
} from "@repo/api/src/types/batch-mutation-result";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/** The documents a batch field update applied to, and the ones it changed. */
type BatchFieldUpdateWrite = {
  appliedIds: Iterable<string>;
  changedIds: readonly string[];
};

/**
 * ISS-12552: one UpdateFields receipt per document a batch field
 * update (status, priority or owner) applied to, on the batch's own
 * transaction; undefined when the request records nothing. A document that
 * already held the value changed nothing, so its receipt is a no-op. A document
 * the batch refused or could not find was not written and gets none.
 */
export function batchFieldUpdateReceiptRecorder(
  receipts: OperationReceiptRecorder,
  field:
    | typeof ArtifactFieldEditField.Status
    | typeof ArtifactFieldEditField.Priority
    | typeof ArtifactFieldEditField.AssigneeId
): RecordWriteInTransaction<BatchFieldUpdateWrite> | undefined {
  return receipts.whenRecording<BatchFieldUpdateWrite>(async (tx, written) => {
    const changed = new Set(written.changedIds);
    for (const documentId of written.appliedIds) {
      const moved = changed.has(documentId);
      await receipts.record(tx, {
        operationKind: OperationKind.UpdateFields,
        outcome: moved
          ? OperationReceiptOutcome.Committed
          : OperationReceiptOutcome.NoOp,
        targetArtifactId: documentId,
        changedFields: moved ? [field] : [],
      });
    }
  });
}

/** The ids a per-item batch applied, in its result map's order. */
export function appliedBatchItemIds(
  resultsById: ReadonlyMap<string, BatchItemResult>
): string[] {
  return [...resultsById.values()]
    .filter((result) => result.status === BATCH_ITEM_APPLIED_STATUS)
    .map((result) => result.id);
}
