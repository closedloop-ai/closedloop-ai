import { updateFieldsReceiptWrite } from "@/app/documents/document-update-receipt";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/**
 * ISS-12552: records one artifact's priority write through
 * `artifactBulkPriorityService.updatePriority` on the write's own transaction,
 * or undefined when the request records nothing.
 */
export function singlePriorityReceiptRecorder(
  receipts: OperationReceiptRecorder,
  artifactId: string
): RecordWriteInTransaction<{ changed: boolean }> | undefined {
  return receipts.whenRecording<{ changed: boolean }>((tx, written) =>
    receipts.record(tx, singlePriorityReceiptWrite(artifactId, written))
  );
}

/**
 * Re-saving the priority the artifact already holds changes nothing, so it is
 * a no-op.
 */
function singlePriorityReceiptWrite(
  artifactId: string,
  written: { changed: boolean }
): OperationReceiptWrite {
  return updateFieldsReceiptWrite(
    artifactId,
    written.changed ? ["priority"] : []
  );
}
