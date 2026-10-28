import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import { updateFieldsReceiptWrite } from "@/app/documents/document-update-receipt";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import type { BulkAssignChange } from "./session-write-service";
import { AgentSessionBulkAssignField } from "./write-contract";

/** What a session create wrote: the session, and whether it is new. */
export type SessionCreateWrite = { artifactId: string; created: boolean };

/**
 * The session fields a single-session write moved, as named on its receipt.
 * Empty when the session already held every requested value.
 */
export type SessionFieldsWrite = { changedFields: string[] };

/** The `changedFields` entry for a session rename (`nameOverride`). */
export const SESSION_NAME_CHANGED_FIELD = "name";

/**
 * ISS-12552: a new session is a committed create; an idempotent
 * retry that resolved the existing row wrote nothing, so it is a no-op.
 */
export function sessionCreateReceiptWrite(
  written: SessionCreateWrite
): OperationReceiptWrite {
  return written.created
    ? {
        operationKind: OperationKind.Create,
        outcome: OperationReceiptOutcome.Committed,
        targetArtifactId: written.artifactId,
        createdArtifactId: written.artifactId,
      }
    : {
        operationKind: OperationKind.Create,
        outcome: OperationReceiptOutcome.NoOp,
        targetArtifactId: written.artifactId,
      };
}

/**
 * ISS-12552: records a single-session field write as a field update naming
 * the fields that moved, or a no-op when none did. Undefined when the request
 * records nothing, so the write runs as it did before receipts.
 */
export function sessionFieldsReceiptRecorder(
  receipts: OperationReceiptRecorder,
  sessionId: string
): RecordWriteInTransaction<SessionFieldsWrite> | undefined {
  return receipts.whenRecording<SessionFieldsWrite>((tx, written) =>
    receipts.record(
      tx,
      updateFieldsReceiptWrite(sessionId, written.changedFields)
    )
  );
}

/**
 * The recorder for `PATCH /agent-sessions/[id]`'s grouping write, or
 * undefined when the request was a rename or a priority write: that write
 * already recorded its receipt, and the grouping call after it only re-reads
 * the row.
 */
export function groupingFieldsReceiptRecorder(
  recordFields: RecordWriteInTransaction<SessionFieldsWrite> | undefined,
  request: { name?: string; priority?: unknown }
): RecordWriteInTransaction<SessionFieldsWrite> | undefined {
  return request.name === undefined && request.priority === undefined
    ? recordFields
    : undefined;
}

/**
 * The artifact column a bulk assignment writes, as named on its receipt. The
 * session Owner is the artifact assignee (ISS-12251 D-1).
 */
export function bulkAssignChangedField(
  field: AgentSessionBulkAssignField
): string {
  return field === AgentSessionBulkAssignField.Project
    ? "projectId"
    : "assigneeId";
}

/**
 * ISS-12552: one field-update receipt per session in a bulk assignment, on the
 * assignment's own transaction; undefined when the request records nothing. A
 * session that already held the target value is a no-op.
 */
export function bulkAssignReceiptRecorder(
  receipts: OperationReceiptRecorder,
  field: AgentSessionBulkAssignField
): RecordWriteInTransaction<readonly BulkAssignChange[]> | undefined {
  const changedField = bulkAssignChangedField(field);
  return receipts.whenRecording<readonly BulkAssignChange[]>(
    async (tx, changes) => {
      for (const change of changes) {
        await receipts.record(
          tx,
          updateFieldsReceiptWrite(
            change.artifactId,
            change.before === change.after ? [] : [changedField]
          )
        );
      }
    }
  );
}
