import type { ArtifactStatus } from "@repo/api/src/types/document";
import type { DocumentStatusTransition } from "@repo/api/src/types/document-status-mutation";
import type { TransactionClient } from "@repo/database";
import { documentWhere } from "@/lib/artifact-adapters";
import type { LockedDocumentRow } from "./document-status-mutation-service";

/**
 * The transitions an eligible row set implies, plus the batch's one guarded
 * write. Shared by `documentStatusMutationService.batchUpdateStatus` and the
 * per-item sibling in `document-status-batch-item-service.ts` (ISS-9464), so
 * neither the change rule nor the write predicate can drift between them.
 *
 * `rows` arrive in REQUEST order, not the lock's id order: `transitions` becomes
 * the activity feed's `changes[]`, and the caller's selection order is the one a
 * reader recognizes. A row already holding `status` is not a transition, so the
 * feed never records a no-op re-apply as a change.
 */
export async function writeStatusChanges(
  tx: TransactionClient,
  rows: LockedDocumentRow[],
  status: ArtifactStatus,
  organizationId: string
): Promise<{
  transitions: DocumentStatusTransition[];
  changedIds: string[];
}> {
  const transitions = rows.flatMap((row): DocumentStatusTransition[] =>
    row.status === status
      ? []
      : [{ documentId: row.id, before: row.status, after: status }]
  );
  const changedIds = transitions.map((transition) => transition.documentId);

  if (changedIds.length > 0) {
    await tx.artifact.updateMany({
      where: documentWhere({ id: { in: changedIds }, organizationId }),
      data: { status },
    });
  }

  return { transitions, changedIds };
}
