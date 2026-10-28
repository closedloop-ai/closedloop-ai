import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/** Whether a skip request wrote the file's terminal skipped state. */
export type TranscriptSkipWrite = { skipped: boolean };

/**
 * ISS-12552: one Desktop sync receipt per skip, recorded in the
 * skip's transaction. A skip that lands on a verified upload changes nothing,
 * so it is a no-op.
 */
export function transcriptSkipReceiptWrite(
  written: TranscriptSkipWrite
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.DesktopSync,
    outcome: written.skipped
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
  };
}
