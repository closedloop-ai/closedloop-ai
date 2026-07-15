import { deleteObjects, listObjects } from "@repo/aws";
import { keys as awsKeys } from "@repo/aws/keys";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS } from "./attachments-service";

/**
 * S3 key prefix under which every document file attachment is stored
 * (`attachments/{org}/{document}/{id}` — see `requestUpload`). Scoping the
 * sweep to this prefix guarantees it only ever touches attachment objects, even
 * if `FILE_ATTACHMENTS_BUCKET` is shared with other object families.
 */
const ATTACHMENT_KEY_PREFIX = "attachments/";

/** Objects per `ListObjectsV2` page (the S3 hard maximum). */
const S3_LIST_PAGE_SIZE = 1000;

export type AttachmentReconcileResult = {
  summary: string;
  /** Objects walked across every list page. */
  scanned: number;
  /** Orphaned objects deleted (had no backing `fileAttachment` row). */
  orphansDeleted: number;
  exitCode: 0 | 1;
};

/**
 * Partitions `keys` into those still referenced by a `fileAttachment` row in
 * `bucket` and those that are not. A bounded `(bucket, key IN (...))` lookup
 * keeps each round-trip within Postgres' parameter cap (page size ≤ 1000) and is
 * served by the `[bucket, key]` index on `file_attachments`.
 *
 * The `bucket` predicate is defense-in-depth: keys are globally-unique ids so a
 * key match already implies the right object, but scoping by bucket guarantees a
 * sweep of one bucket can never be influenced by a row recorded against another
 * (e.g. a future multi-bucket setup) and lets the composite index do the work.
 */
async function findUnreferencedKeys(
  keys: string[],
  bucket: string
): Promise<string[]> {
  if (keys.length === 0) {
    return [];
  }
  const existing = await withDb((db) =>
    db.fileAttachment.findMany({
      where: { bucket, key: { in: keys } },
      select: { key: true },
    })
  );
  const referenced = new Set(existing.map((row) => row.key));
  return keys.filter((key) => !referenced.has(key));
}

export const attachmentReconcileService = {
  /**
   * Reconciles the `FILE_ATTACHMENTS_BUCKET` against the `fileAttachment` table,
   * deleting S3 objects that have no backing row (ORPHANED_OBJECT). These arise
   * when `deleteAttachment` commits the row delete but the best-effort S3 delete
   * throws, leaving the object stranded in the bucket forever.
   *
   * Objects younger than `ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS` are left
   * alone: an upload may still be legitimately in flight against its presigned
   * PUT, or a read-replica may not yet reflect a just-created row. Such objects
   * are reconsidered on the next sweep once past that window.
   *
   * The reciprocal direction — `fileAttachment` rows pointing at a missing
   * object (abandoned client-side uploads) — is reconciled separately on the
   * DB-row side and is intentionally out of scope here.
   *
   * Returns a structured summary; `exitCode` is 1 when the sweep errored so the
   * cron route can alert and return 500.
   */
  async runReconcileSweep(
    now: Date = new Date()
  ): Promise<AttachmentReconcileResult> {
    const bucket = awsKeys().FILE_ATTACHMENTS_BUCKET;
    if (!bucket) {
      // No bucket configured (e.g. local/dev) → nothing to reconcile. Mirrors
      // the upload path, which only errors when an upload is actually attempted.
      return {
        summary: "FILE_ATTACHMENTS_BUCKET not configured; reconcile skipped",
        scanned: 0,
        orphansDeleted: 0,
        exitCode: 0,
      };
    }

    const cutoff = new Date(
      now.getTime() - ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS * 1000
    );

    // Hoisted so the catch block can report progress made before a mid-sweep
    // failure rather than masking it with zeros.
    let scanned = 0;
    let orphansDeleted = 0;

    try {
      let continuationToken: string | undefined;

      do {
        const page = await listObjects({
          prefix: ATTACHMENT_KEY_PREFIX,
          continuationToken,
          maxKeys: S3_LIST_PAGE_SIZE,
          bucket,
        });
        scanned += page.objects.length;

        // Only objects past the in-flight upload window are reconcilable. An
        // object with no LastModified has indeterminate age, so it is skipped
        // (never deleted) rather than risk removing a live upload.
        const candidateKeys = page.objects
          .filter(
            (obj) => obj.lastModified !== undefined && obj.lastModified < cutoff
          )
          .map((obj) => obj.key);

        const orphanKeys = await findUnreferencedKeys(candidateKeys, bucket);
        if (orphanKeys.length > 0) {
          // One batched DeleteObjects per page (orphanKeys ≤ page size ≤ 1000)
          // instead of a round-trip per key, so even a large backlog clears in a
          // handful of calls and is far less likely to hit the function timeout.
          await deleteObjects(orphanKeys, bucket);
          orphansDeleted += orphanKeys.length;
        }

        continuationToken = page.nextContinuationToken;
      } while (continuationToken);

      return {
        summary: `Scanned ${scanned} attachment object(s); deleted ${orphansDeleted} orphaned object(s) with no backing row (older than ${ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS}s)`,
        scanned,
        orphansDeleted,
        exitCode: 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("[reconcile-attachments] reconcile sweep failed", {
        error: message,
        scanned,
        orphansDeleted,
        cutoff: cutoff.toISOString(),
      });
      return {
        summary: `Attachment reconcile sweep failed after scanning ${scanned} object(s), deleting ${orphansDeleted}: ${message}`,
        scanned,
        orphansDeleted,
        exitCode: 1,
      };
    }
  },
};
