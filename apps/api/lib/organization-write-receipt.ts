import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/** Whether an organization-setup write changed anything it persists. */
export type OrganizationWriteOutcome = { changed: boolean };

/**
 * ISS-12552: the receipt for an organization-setup write
 * (catalog, compute targets, distributions, integrations). It names no
 * artifact; a write that changed nothing is a no-op.
 */
export function organizationWriteReceipt(
  written: OrganizationWriteOutcome
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.OrganizationWrite,
    outcome: written.changed
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
  };
}

/**
 * ISS-12552: a request that succeeded without opening a write transaction
 * (nothing to disconnect, a deduplicated retry, an existing promotion) still
 * gets its no-op receipt, in a short transaction of its own.
 */
export async function recordNoOpUnlessRecorded(
  receipts: OperationReceiptRecorder
): Promise<void> {
  if (receipts.receipt) {
    return;
  }
  await receipts.recordStandalone(organizationWriteReceipt({ changed: false }));
}

/**
 * ISS-12552: the record an organization-setup service writes with, or
 * undefined when the request records nothing, so the service runs its write
 * exactly as it did before receipts (`writeInShape`).
 */
export function recordOrganizationWrite(
  receipts: OperationReceiptRecorder
): RecordWriteInTransaction<OrganizationWriteOutcome> | undefined {
  return receipts.whenRecording<OrganizationWriteOutcome>((tx, written) =>
    receipts.record(tx, organizationWriteReceipt(written))
  );
}
