import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { TransactionClient } from "@repo/database";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { ContextDocumentWrite } from "./context-document-service";
import { documentAttachReceiptWrite } from "./document-attach-receipt";

/**
 * ISS-12552: the receipts for one context PRD, one per write it
 * made: its attachment, its PRODUCES link, and its creation. The creation is
 * recorded last so a route answering with one receipt answers with it.
 */
export async function recordContextDocumentReceipts(
  receipts: OperationReceiptRecorder,
  tx: TransactionClient,
  written: ContextDocumentWrite
): Promise<void> {
  if (written.attachmentId !== undefined) {
    await receipts.record(tx, documentAttachReceiptWrite(written.documentId));
  }
  await receipts.record(tx, {
    operationKind: OperationKind.LinkCreate,
    outcome: OperationReceiptOutcome.Committed,
    targetArtifactId: written.documentId,
    linkId: written.linkId,
  });
  await receipts.record(tx, {
    operationKind: OperationKind.Create,
    outcome: OperationReceiptOutcome.Committed,
    targetArtifactId: written.documentId,
    createdArtifactId: written.documentId,
    versionNumber: 1,
  });
}
