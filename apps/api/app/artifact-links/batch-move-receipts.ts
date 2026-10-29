import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { BatchProjectChange } from "@/lib/artifact-activity-capture";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/**
 * ISS-12552: one move receipt per artifact a batch move wrote,
 * on the move's own transaction; undefined when the request records nothing.
 * An artifact already in the target project did not change, so its receipt is
 * a no-op.
 */
export function batchMoveReceiptRecorder(
  receipts: OperationReceiptRecorder
): RecordWriteInTransaction<readonly BatchProjectChange[]> | undefined {
  return receipts.whenRecording<readonly BatchProjectChange[]>(
    async (tx, projectChanges) => {
      for (const change of projectChanges) {
        await receipts.record(
          tx,
          change.before === change.after
            ? {
                operationKind: OperationKind.Move,
                outcome: OperationReceiptOutcome.NoOp,
                targetArtifactId: change.artifactId,
              }
            : {
                operationKind: OperationKind.Move,
                outcome: OperationReceiptOutcome.Committed,
                targetArtifactId: change.artifactId,
                changedFields: ["projectId"],
              }
        );
      }
    }
  );
}
