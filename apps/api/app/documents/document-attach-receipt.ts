import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: an attachment row created on a document. Every
 * upload request stores a new row, so it is never a no-op.
 */
export function documentAttachReceiptWrite(
  documentId: string
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.Attach,
    outcome: OperationReceiptOutcome.Committed,
    targetArtifactId: documentId,
  };
}
