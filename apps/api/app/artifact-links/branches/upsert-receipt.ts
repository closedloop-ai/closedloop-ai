import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { BranchUpsertWrite } from "@/app/branches/branch-service";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552 (PRD-800 "An update or saved version that changes no
 * content and no persisted field is a no-op"): a new branch is a committed
 * create naming it; an upsert that moved a persisted field is a committed
 * field update naming those fields; only an upsert that moved nothing is a
 * no-op.
 */
export function branchUpsertReceiptWrite(
  branch: Pick<BranchUpsertWrite, "id" | "created" | "changedFields">
): OperationReceiptWrite {
  if (branch.created) {
    return {
      operationKind: OperationKind.Create,
      outcome: OperationReceiptOutcome.Committed,
      targetArtifactId: branch.id,
      createdArtifactId: branch.id,
    };
  }
  if (branch.changedFields.length > 0) {
    return {
      operationKind: OperationKind.UpdateFields,
      outcome: OperationReceiptOutcome.Committed,
      targetArtifactId: branch.id,
      changedFields: branch.changedFields,
    };
  }
  return {
    operationKind: OperationKind.Create,
    outcome: OperationReceiptOutcome.NoOp,
    targetArtifactId: branch.id,
  };
}
