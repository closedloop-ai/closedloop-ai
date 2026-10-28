import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: one Desktop sync receipt per status report
 * request, recorded in the transaction that upserts its reports. A request
 * whose reports all named another organization's distributions stored
 * nothing, so it is a no-op.
 */
export function distributionStatusReceiptWrite(
  acceptedReports: number
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.DesktopSync,
    outcome:
      acceptedReports > 0
        ? OperationReceiptOutcome.Committed
        : OperationReceiptOutcome.NoOp,
  };
}
