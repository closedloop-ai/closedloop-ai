import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/** What a grid preference write did, for its receipt. */
export type GridPreferenceWrite = { changed: boolean };

/**
 * ISS-12552: a grid preference is the caller's own setting, so
 * its receipt is a settings write with no artifact target. Resetting a
 * preference that is not stored changes nothing, so it is a no-op.
 */
export function gridPreferenceReceiptWrite(
  written: GridPreferenceWrite
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.SettingsWrite,
    outcome: written.changed
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
  };
}

/**
 * ISS-12552: the record a grid preference write takes, or undefined when the
 * request records nothing, so the write keeps its pre-receipt shape.
 */
export function recordGridPreferenceWrite(
  receipts: OperationReceiptRecorder
): RecordWriteInTransaction<GridPreferenceWrite> | undefined {
  return receipts.whenRecording<GridPreferenceWrite>((tx, written) =>
    receipts.record(tx, gridPreferenceReceiptWrite(written))
  );
}
