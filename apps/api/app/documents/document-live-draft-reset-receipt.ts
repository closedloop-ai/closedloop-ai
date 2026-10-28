import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";
import type { LiveDraftResetResult } from "./live-draft-service";

/**
 * ISS-12552: an API-key live-draft reset, recorded once doc-sync confirms it
 * (Daveth, 2026-10-22). A reset doc-sync did not apply changed nothing, so it
 * is a no-op (PRD-800).
 */
export function liveDraftResetReceiptWrite(
  documentId: string,
  result: LiveDraftResetResult
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.LiveDraftReset,
    outcome: result.reset.applied
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
    targetArtifactId: documentId,
    versionNumber: result.version,
  };
}
