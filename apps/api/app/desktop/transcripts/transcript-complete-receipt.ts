import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/** Whether a completion request writes the transcript row at all. */
export type TranscriptCompleteWrite = { changed: boolean };

/**
 * ISS-12552: one Desktop sync receipt per completion, recorded
 * in the completion's transaction before any S3 call. It describes the row
 * write that commits, which marks the row completed or failed, not what S3
 * answered. `changedFields` stays empty because the two writes set different
 * columns. A retried completion of an already verified upload writes nothing,
 * so it is a no-op.
 */
export function transcriptCompleteReceiptWrite(
  written: TranscriptCompleteWrite
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.DesktopSync,
    outcome: written.changed
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
  };
}
