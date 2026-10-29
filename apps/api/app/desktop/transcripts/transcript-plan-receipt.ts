import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { TranscriptSyncPlanResponse } from "@repo/api/src/types/desktop-transcripts";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: one Desktop sync receipt per sync plan. A plan for
 * content that is already uploaded changes nothing, so it is a no-op.
 */
export function transcriptPlanReceiptWrite(
  plan: TranscriptSyncPlanResponse
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.DesktopSync,
    outcome:
      plan.mode === "noop"
        ? OperationReceiptOutcome.NoOp
        : OperationReceiptOutcome.Committed,
  };
}
