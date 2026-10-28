import {
  type OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: the receipt for a write that targets no artifact,
 * such as an organization definition or a caller's own setting. A write that
 * moved nothing is a no-op ("An update or saved version that changes no
 * content and no persisted field is a no-op").
 */
export function machineWriteReceipt(
  operationKind: OperationKind,
  changed: boolean,
  changedFields: readonly string[] = []
): OperationReceiptWrite {
  return {
    operationKind,
    outcome: changed
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
    changedFields,
  };
}

/** The receipt for a field update: a no-op when no requested field moved. */
export function machineUpdateReceipt(
  operationKind: OperationKind,
  changedFields: readonly string[]
): OperationReceiptWrite {
  return machineWriteReceipt(
    operationKind,
    changedFields.length > 0,
    changedFields
  );
}
