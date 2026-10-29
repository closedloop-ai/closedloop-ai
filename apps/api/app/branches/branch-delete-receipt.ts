import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: deleting a branch artifact is a committed delete
 * naming the branch. A delete that matched nothing writes nothing and answers
 * 404, so it never reaches this receipt.
 */
export function branchDeleteReceiptWrite(written: {
  artifactId: string;
}): OperationReceiptWrite {
  return {
    operationKind: OperationKind.Delete,
    outcome: OperationReceiptOutcome.Committed,
    targetArtifactId: written.artifactId,
  };
}
