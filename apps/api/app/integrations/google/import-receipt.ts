import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { Document } from "@repo/api/src/types/document";
import type { RecordCreatedArtifact } from "@/app/documents/document-service";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";

/**
 * ISS-12552: a Drive import is a batch of document creates,
 * so each imported document gets its own create receipt on its own create
 * transaction. The seeded content is version 1. Undefined when the request
 * records nothing.
 */
export function importedDocumentReceipt(
  receipts: OperationReceiptRecorder
): RecordCreatedArtifact | undefined {
  return receipts.whenRecording<Document>((tx, created) =>
    receipts.record(tx, {
      operationKind: OperationKind.Create,
      outcome: OperationReceiptOutcome.Committed,
      targetArtifactId: created.id,
      createdArtifactId: created.id,
      versionNumber: 1,
    })
  );
}
