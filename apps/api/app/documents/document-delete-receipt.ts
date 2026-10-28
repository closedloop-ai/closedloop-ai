import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/**
 * ISS-12552: an API-key delete of a document. Only a document
 * that was actually deleted gets one, so it is always committed.
 */
export function documentDeleteReceiptWrite(
  documentId: string
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.Delete,
    outcome: OperationReceiptOutcome.Committed,
    targetArtifactId: documentId,
  };
}

/**
 * One receipt per document a batch delete removed, on the batch's own
 * transaction; undefined when the request records nothing. An id the batch
 * could not find deleted nothing, so it gets none.
 */
export function batchDeleteReceiptRecorder(
  receipts: OperationReceiptRecorder
): RecordWriteInTransaction<{ deletedIds: readonly string[] }> | undefined {
  return receipts.whenRecording<{ deletedIds: readonly string[] }>(
    async (tx, { deletedIds }) => {
      for (const documentId of deletedIds) {
        await receipts.record(tx, documentDeleteReceiptWrite(documentId));
      }
    }
  );
}
