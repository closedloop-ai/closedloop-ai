import {
  type OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import type { RecordBatchTagReceipt } from "./batch-tag-locks";
import {
  type BatchTagSideEffectInput,
  captureBatchTagActivity,
} from "./batch-tag-side-effects";

type BatchTagOperationKind =
  | typeof OperationKind.Tag
  | typeof OperationKind.Untag;

/** The artifacts a batch tag write resolved, and the ones it changed. */
type BatchTagWrite = {
  targetIds: readonly string[];
  changedIds: readonly string[];
};

/**
 * The batch routes' in-transaction callback: the activity receipt (ISS-10993)
 * and then the per-artifact operation receipts (ISS-12552).
 */
export function recordBatchTagWrite(
  receipts: OperationReceiptRecorder,
  operationKind: BatchTagOperationKind,
  activity: Omit<BatchTagSideEffectInput, "changedIds">
): RecordBatchTagReceipt {
  const recordReceipts = batchTagReceiptRecorder(receipts, operationKind);
  return async (tx, changedIds, targetIds) => {
    await captureBatchTagActivity(tx, {
      ...activity,
      changedIds: [...changedIds],
    });
    await recordReceipts?.(tx, { targetIds, changedIds });
  };
}

/**
 * ISS-12552: one operation receipt per artifact a batch tag
 * write resolved, on the batch's own transaction; undefined when the request
 * records nothing. An artifact that already carried the tag (apply) or never
 * did (remove) changed nothing, so its receipt is a no-op, the same as the
 * single `/entity-tags` route.
 */
function batchTagReceiptRecorder(
  receipts: OperationReceiptRecorder,
  operationKind: BatchTagOperationKind
): RecordWriteInTransaction<BatchTagWrite> | undefined {
  return receipts.whenRecording<BatchTagWrite>(
    async (tx, { targetIds, changedIds }) => {
      const changed = new Set(changedIds.map((id) => id.toLowerCase()));
      for (const targetArtifactId of targetIds) {
        await receipts.record(tx, {
          operationKind,
          outcome: changed.has(targetArtifactId.toLowerCase())
            ? OperationReceiptOutcome.Committed
            : OperationReceiptOutcome.NoOp,
          targetArtifactId,
        });
      }
    }
  );
}
