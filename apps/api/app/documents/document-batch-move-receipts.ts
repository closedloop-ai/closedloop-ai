import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { BatchProjectChange } from "@/lib/artifact-activity-capture";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/**
 * ISS-12552: one Move receipt per document a batch move wrote,
 * on the batch's own transaction; undefined when the request records nothing.
 * Every written document has its sort order rewritten to the bottom of the
 * target project's stack rank; its project moves only when it came from
 * another one. A document the batch could not find was not written and gets
 * none.
 */
export function batchMoveReceiptRecorder(
  receipts: OperationReceiptRecorder
): RecordWriteInTransaction<readonly BatchProjectChange[]> | undefined {
  return receipts.whenRecording<readonly BatchProjectChange[]>(
    async (tx, projectChanges) => {
      for (const change of projectChanges) {
        await receipts.record(tx, {
          operationKind: OperationKind.Move,
          outcome: OperationReceiptOutcome.Committed,
          targetArtifactId: change.artifactId,
          changedFields:
            change.before === change.after
              ? ["sortOrder"]
              : ["projectId", "sortOrder"],
        });
      }
    }
  );
}
