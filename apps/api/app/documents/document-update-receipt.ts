import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { Document } from "@repo/api/src/types/document";
import { fieldsThatMoved } from "@/lib/operation-receipts/changed-fields";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: the persisted document fields `PUT /documents/[id]` can write.
 * The `expected*` keys are compare-and-set guards, not writes, so they never
 * count as a change. Every entry must be a `Document` key, so a renamed column
 * fails `tsc` here instead of silently dropping out of the diff.
 */
export const DOCUMENT_UPDATE_FIELDS = [
  "title",
  "fileName",
  "status",
  "priority",
  "dueDate",
  "projectId",
  "assigneeId",
  "approverId",
  "sortOrder",
] as const satisfies readonly (keyof Document)[];

/**
 * The fields the request asked to write whose stored value actually moved.
 * An unchanged re-save returns an empty list, which makes it a no-op.
 */
export function changedDocumentFields(
  requested: Partial<Record<(typeof DOCUMENT_UPDATE_FIELDS)[number], unknown>>,
  previous: Document,
  next: Document
): string[] {
  return fieldsThatMoved(DOCUMENT_UPDATE_FIELDS, requested, previous, next);
}

/** The receipt for a field update, a no-op when nothing moved. */
export function updateFieldsReceiptWrite(
  documentId: string,
  changedFields: readonly string[]
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.UpdateFields,
    outcome:
      changedFields.length > 0
        ? OperationReceiptOutcome.Committed
        : OperationReceiptOutcome.NoOp,
    targetArtifactId: documentId,
    changedFields,
  };
}
