import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/** A stored rating, and whether it moved anything the caller had stored. */
export type DocumentRatingWrite = { changed: boolean };

/**
 * ISS-12552: a rating on a document, either the document rating
 * or a rating of one of its judge scores. Re-sending a rating the caller
 * already gave changes nothing, so it is a no-op.
 */
export function documentRatingReceiptWrite(
  documentId: string,
  written: DocumentRatingWrite
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.Rate,
    outcome: written.changed
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
    targetArtifactId: documentId,
  };
}
