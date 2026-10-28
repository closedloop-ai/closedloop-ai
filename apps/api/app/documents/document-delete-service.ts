import { ArtifactType } from "@repo/api/src/types/artifact";
import { AuditAction, AuditObjectType } from "@repo/api/src/types/audit";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import type { ArtifactSubtype } from "@repo/database";
import { withDb } from "@repo/database";
import {
  type AuditActor,
  enqueueAuditEvent,
  enqueueAuditEvents,
} from "@/app/audit/audit-emit-service";
import { searchIndexService } from "@/app/search/search-index-service";
import { withBulkTransaction } from "@/lib/bulk-mutation-transaction";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import { deleteDocumentRoom } from "./room-utils";

/**
 * The document delete path, split out of `document-service.ts` (ISS-10029) so
 * the delete and the audit entry that is now its only survivor live together
 * rather than adding to an already over-size module.
 */

/**
 * The artifact columns a `document.deleted` entry's `detail` is built from.
 * Every field is required, so a column dropped from a caller's `select` fails
 * `tsc` rather than persisting an entry that is silently missing half the
 * record it exists to preserve.
 */
export type DeletedDocumentRow = {
  slug: string | null;
  name: string;
  subtype: ArtifactSubtype | null;
  status: string;
  projectId: string | null;
};

/**
 * The Prisma `select` that yields a {@link DeletedDocumentRow}. Shared so the
 * three delete paths (single, batch, merge) read the same columns and cannot
 * drift into recording different things about the same kind of event.
 */
export const DELETED_DOCUMENT_SELECT = {
  slug: true,
  name: true,
  subtype: true,
  status: true,
  projectId: true,
} as const;

/**
 * The `detail` payload of a `document.deleted` entry. The entry outlives the
 * artifact, so this shape is all the product will ever know about the row
 * again — which is why it is one exported type rather than an object literal
 * rebuilt at each of the three delete paths.
 */
export type DeletedDocumentAuditDetail = {
  slug: string | null;
  title: string;
  subtype: ArtifactSubtype | null;
  status: string;
  projectId: string | null;
};

/**
 * Build the `detail` payload for a `document.deleted` entry from the row that
 * was deleted.
 */
export function deletedDocumentAuditDetail(
  row: DeletedDocumentRow
): DeletedDocumentAuditDetail {
  return {
    slug: row.slug,
    // `name` is the column; `title` is the word the document contract uses
    // for it everywhere else (see toDocument).
    title: row.name,
    subtype: row.subtype,
    status: row.status,
    projectId: row.projectId,
  };
}

/**
 * The document delete surface. `documentService.delete` is the adapter routes
 * reach this through; nothing imports the operations directly.
 *
 * `delete` removes a DOCUMENT artifact, its audit entry, and its Liveblocks
 * room.
 * ArtifactLink rows cascade via FK ON DELETE CASCADE.
 *
 * The delete is HARD, so its audit entry is the only record that outlives it
 * (ISS-10029): versions, links and comment threads go with the row, and a
 * document deleted without ever changing status previously left no trace in the
 * product at all. The entry is therefore enqueued in the SAME transaction as
 * the row delete, which makes the pair atomic in both directions — a delete
 * cannot commit without its audit record, and an audit write that cannot be
 * made rolls the delete back instead of destroying the document silently.
 * `detail` carries the fields that die with the artifact, so the entry still
 * reads as a record of something after the row is gone.
 *
 * That `detail` is built from the row `delete` ITSELF returns, never from a
 * read taken before the transaction: a concurrent update committing in between
 * would otherwise make this permanent entry describe a version of the artifact
 * that is not the one that disappeared. The pre-read that remains selects only
 * `type`, which decides whether to delete at all rather than what to record.
 *
 * `actor` is required rather than defaulted so every caller states who caused
 * the delete: the user-facing routes attribute their authenticated user, and an
 * internal compensating delete of an artifact the same request just created
 * attributes `system`.
 *
 * `recordWrite` runs on the delete's own transaction, after the audit entry,
 * so an operation receipt that cannot be stored rolls the delete back
 * (ISS-12552). It does not run when there was no document to delete.
 */
export const documentDeleteService = {
  async delete(
    id: string,
    organizationId: string,
    actor: AuditActor,
    recordWrite?: RecordWriteInTransaction<{ documentId: string }>
  ): Promise<void> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
        select: { type: true },
      })
    );

    if (artifact?.type !== ArtifactType.Document) {
      return;
    }

    const deleted = await withDb.tx(async (tx) => {
      const row = await tx.artifact.delete({
        where: { id, organizationId },
        select: DELETED_DOCUMENT_SELECT,
      });
      // Joins this transaction via withDb's AsyncLocalStorage, and throws
      // rather than swallowing, so the row delete above rolls back with it.
      await enqueueAuditEvent({
        organizationId,
        actor,
        action: AuditAction.DocumentDeleted,
        objectType: AuditObjectType.Document,
        objectId: id,
        detail: deletedDocumentAuditDetail(row),
      });
      await recordWrite?.(tx, { documentId: id });
      return row;
    });

    // FEA-3863: best-effort, post-commit, fail-open search projection removal.
    // Outside the transaction deliberately, alongside the Liveblocks call
    // below: neither may widen the window the delete holds its transaction
    // open.
    searchIndexService.removeAfterCommit({
      organizationId,
      entityType: SearchEntityType.Document,
      entityId: id,
    });

    if (deleted.slug) {
      await deleteDocumentRoom(organizationId, deleted.slug);
    }
  },

  /**
   * Enqueue one `document.deleted` entry per row a BATCH delete destroyed, in
   * the caller's transaction (ISS-10029). Lives beside the single-document
   * delete so both paths build their entry through the same detail helper.
   *
   * `deleteMany` returns a count, not rows, so the caller passes the rows it
   * read inside the same transaction — the same snapshot the delete acts on.
   *
   * `transactionId` groups the batch's entries (ISS-9465). There is no activity
   * counterpart to group them with, deliberately: `artifact_activity_events`
   * cascades on the artifact, so a receipt for a deletion would be destroyed by
   * the deletion it records (ruling 2).
   */
  enqueueBatchAuditEvents(
    organizationId: string,
    actor: AuditActor,
    rows: readonly (DeletedDocumentRow & { id: string })[],
    transactionId: string
  ): Promise<void> {
    return enqueueAuditEvents(
      rows.map((row) => ({
        organizationId,
        actor,
        action: AuditAction.DocumentDeleted,
        objectType: AuditObjectType.Document,
        objectId: row.id,
        detail: withBulkTransaction(
          deletedDocumentAuditDetail(row),
          transactionId
        ),
      }))
    );
  },
};
