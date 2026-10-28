import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import { customFieldChanges } from "@/lib/operation-receipts/changed-fields";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/**
 * ISS-12552: setting or clearing one custom field value on a
 * session or branch is a field update on that artifact. A value that did not
 * move is a no-op and names no field.
 */
export function customFieldValueReceiptWrite(
  artifactId: string,
  fieldId: string,
  changed: boolean
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.UpdateFields,
    outcome: changed
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
    targetArtifactId: artifactId,
    changedFields: changed ? customFieldChanges([fieldId]) : [],
  };
}

/**
 * The value services' in-transaction callback for one field on one artifact;
 * undefined for a request that gets no receipt.
 */
export function recordCustomFieldValueWrite(
  receipts: OperationReceiptRecorder,
  artifactId: string,
  fieldId: string
): RecordWriteInTransaction<{ changed: boolean }> | undefined {
  return receipts.whenRecording<{ changed: boolean }>((tx, { changed }) =>
    receipts.record(
      tx,
      customFieldValueReceiptWrite(artifactId, fieldId, changed)
    )
  );
}
