import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { UpsertSessionSliceResult } from "@/app/agent-sessions/service/session-slice-result";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: one Desktop sync receipt per session, recorded in
 * that session's slice transaction. A slice the ingest held without writing
 * stored nothing, so it is a no-op.
 */
export function sessionSyncReceiptWrite(
  written: UpsertSessionSliceResult
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.DesktopSync,
    outcome: written.persisted
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
  };
}
