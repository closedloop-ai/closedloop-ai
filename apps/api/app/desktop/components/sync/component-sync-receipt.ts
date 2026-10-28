import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: one Desktop sync receipt per inventory write, each
 * recorded in that write's own transaction: one per component, and one for
 * the request's retained variant rows when it carries any. Every component
 * write stamps its last-seen time, so each one commits.
 */
export function componentSyncReceiptWrite(): OperationReceiptWrite {
  return {
    operationKind: OperationKind.DesktopSync,
    outcome: OperationReceiptOutcome.Committed,
  };
}
