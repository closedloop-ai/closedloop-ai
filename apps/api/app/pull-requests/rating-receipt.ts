import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";
import type { RatingWrite } from "./ratings-service";

/**
 * ISS-12552: a rating on the branch artifact the legacy pull
 * request route names. Re-submitting the score and comment the caller already
 * left changes nothing, so it is a no-op.
 */
export function ratingReceiptWrite(
  artifactId: string,
  written: RatingWrite
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.Rate,
    outcome: written.changed
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
    targetArtifactId: artifactId,
  };
}
