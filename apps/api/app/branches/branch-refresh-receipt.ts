import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: an API-key branch refresh records one field update
 * naming the branch, inside the transaction that spends the caller's refresh
 * budget. The pull request projections the refresh then reads from GitHub are
 * a sync of GitHub state, so the receipt names no changed fields.
 */
export function branchRefreshReceiptWrite(
  branchArtifactId: string
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.UpdateFields,
    outcome: OperationReceiptOutcome.Committed,
    targetArtifactId: branchArtifactId,
  };
}
