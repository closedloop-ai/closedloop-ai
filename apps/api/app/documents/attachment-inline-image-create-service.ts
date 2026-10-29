/**
 * Inline-image attachment creation: decode API-owned bytes, validate them,
 * consume the shared upload limit, write the object to S3, and persist the row.
 *
 * Split out of `attachments-service.ts`, which owns upload, listing, delete,
 * download and inline-ref resolution, so that file clears the 1,000-line
 * ceiling (AGENTS.md -> "File Size and Organization"). The three helpers it
 * borrows back are sibling imports, which `apps/api/AGENTS.md` sanctions; a
 * re-export facade would not be.
 *
 * Log messages keep the `[attachments-service]` prefix they were emitted under
 * before the split. Datadog queries key on that literal, so renaming it here
 * would silently break them for no behavioral gain.
 */
import "server-only";
import { createId } from "@paralleldrive/cuid2";
import type { CreateInlineImageAttachmentResponse } from "@repo/api/src/types/attachment";
import {
  AttachmentPurpose,
  buildInlineAttachmentRef,
  CreateInlineImageAttachmentErrorCode as CreateInlineImageAttachmentErrorCodeContract,
} from "@repo/api/src/types/attachment";
import {
  Result,
  type Result as ServiceResult,
} from "@repo/api/src/types/result";
import { deleteArtifact, putAttachmentObject } from "@repo/aws";
import { keys as awsKeys } from "@repo/aws/keys";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import type { CreateInlineImageAttachmentError } from "@/app/documents/inline-image-attachment-contract";
import {
  decodeInlineImageBase64,
  validateInlineImageBytes,
} from "@/app/documents/inline-image-bytes";
import {
  type RecordWriteInTransaction,
  writeRecorded,
} from "@/lib/record-write-in-transaction";
import { getSafeAttachmentStorageErrorMessage } from "./attachment-storage-key-redaction";
import { consumeAttachmentUploadLimit } from "./attachment-upload-rate-limit";
import {
  ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS,
  FILE_ATTACHMENT_API_SELECT,
  type InlineImageAttachmentPersistenceRecord,
  isDocumentNotFoundError,
  requireDocument,
  toFileAttachment,
} from "./attachments-service";

const ATTACHMENT_ORPHAN_RECOVERY_MODE = "scheduled_attachment_reconcile_sweep";

type CreateInlineImageAttachmentResult = ServiceResult<
  CreateInlineImageAttachmentResponse,
  CreateInlineImageAttachmentError
>;

export const attachmentInlineImageCreateService = {
  /**
   * Create an inline image attachment from API-owned bytes in one call.
   */
  async createInlineImageAttachment(
    documentId: string,
    organizationId: string,
    userId: string,
    filename: string,
    mimeType: string,
    dataBase64: string,
    recordCreated?: RecordWriteInTransaction<{ attachmentId: string }>
  ): Promise<CreateInlineImageAttachmentResult> {
    const bucket = awsKeys().FILE_ATTACHMENTS_BUCKET;
    if (!bucket) {
      log.error(
        "[attachments-service] Inline image attachment missing bucket",
        {
          documentId,
          mimeType,
          reason:
            CreateInlineImageAttachmentErrorCodeContract.StorageUnconfigured,
        }
      );
      return Result.err({
        code: CreateInlineImageAttachmentErrorCodeContract.StorageUnconfigured,
      });
    }

    try {
      await requireDocument(documentId, organizationId);
    } catch (error) {
      if (isDocumentNotFoundError(error)) {
        return Result.err({
          code: CreateInlineImageAttachmentErrorCodeContract.DocumentNotFound,
        });
      }
      throw error;
    }

    const limitResult = await consumeAttachmentUploadLimit(
      organizationId,
      documentId
    );
    if (limitResult.ok === false) {
      return Result.err({
        code: CreateInlineImageAttachmentErrorCodeContract.RateLimited,
        retryAfterSeconds: limitResult.error.retryAfterSeconds,
      });
    }

    const decoded = decodeInlineImageBase64(dataBase64);
    if (!decoded.ok) {
      return Result.err(decoded.error);
    }

    const validation = validateInlineImageBytes(mimeType, decoded.value);
    if (!validation.ok) {
      return Result.err(validation.error);
    }

    const key = `attachments/${organizationId}/${documentId}/${createId()}`;
    try {
      await putAttachmentObject({
        body: decoded.value,
        bucket,
        contentLength: decoded.value.byteLength,
        contentType: mimeType,
        key,
      });
    } catch (error) {
      log.error(
        "[attachments-service] Inline image attachment S3 write failed",
        {
          documentId,
          error: getSafeAttachmentStorageErrorMessage(error),
          mimeType,
          reason:
            CreateInlineImageAttachmentErrorCodeContract.StorageWriteFailed,
          sizeBytes: decoded.value.byteLength,
        }
      );
      return Result.err({
        code: CreateInlineImageAttachmentErrorCodeContract.StorageWriteFailed,
      });
    }

    try {
      // Recorded, the inner `withDb` joins the record's transaction so the
      // row and its receipt commit together; unrecorded, no transaction.
      const created = await writeRecorded(
        recordCreated,
        () =>
          withDb((db) =>
            db.fileAttachment.create({
              data: {
                artifactId: documentId,
                bucket,
                key,
                filename,
                mimeType,
                sizeBytes: decoded.value.byteLength,
                createdById: userId,
                purpose: AttachmentPurpose.Inline,
              },
            })
          ),
        (row) => ({ attachmentId: row.id })
      );
      return Result.ok({
        attachment: toFileAttachment(created),
        attachmentId: created.id,
        attachmentRef: buildInlineAttachmentRef(created.id),
      });
    } catch (error) {
      const persistedRecord = await findPersistedInlineImageAttachment({
        bucket,
        documentId,
        key,
        organizationId,
      });
      if (persistedRecord.ok) {
        const created = persistedRecord.value;
        if (created) {
          return Result.ok({
            attachment: toFileAttachment(created),
            attachmentId: created.id,
            attachmentRef: buildInlineAttachmentRef(created.id),
          });
        }
        await cleanupFailedInlineImageAttachment({
          bucket,
          documentId,
          error,
          key,
          mimeType,
          sizeBytes: decoded.value.byteLength,
        });
      } else {
        // The DB create may have committed even though the client observed an
        // error. Do not delete the S3 object when the status lookup also fails:
        // a committed row would then point at missing storage. If no row exists,
        // the scheduled attachment reconcile sweep removes the unreferenced
        // attachments/ object after the in-flight upload window.
        log.error(
          "[attachments-service] Inline image attachment persistence status check failed",
          {
            documentId,
            error: getSafeAttachmentStorageErrorMessage(error),
            lookupError: getSafeAttachmentStorageErrorMessage(
              persistedRecord.error
            ),
            mimeType,
            recoveryMode: ATTACHMENT_ORPHAN_RECOVERY_MODE,
            reconcileAfterSeconds: ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS,
            reason: "inline_image_persistence_status_unknown",
            sizeBytes: decoded.value.byteLength,
          }
        );
      }
      return Result.err({
        code: CreateInlineImageAttachmentErrorCodeContract.PersistenceFailed,
      });
    }
  },
};

async function findPersistedInlineImageAttachment({
  bucket,
  documentId,
  key,
  organizationId,
}: {
  bucket: string;
  documentId: string;
  key: string;
  organizationId: string;
}): Promise<
  ServiceResult<InlineImageAttachmentPersistenceRecord | null, unknown>
> {
  try {
    const record = await withDb((db) =>
      db.fileAttachment.findFirst({
        where: {
          artifactId: documentId,
          artifact: { organizationId },
          bucket,
          key,
        },
        select: FILE_ATTACHMENT_API_SELECT,
      })
    );
    return Result.ok(record);
  } catch (lookupError) {
    return Result.err(lookupError);
  }
}

async function cleanupFailedInlineImageAttachment({
  bucket,
  documentId,
  error,
  key,
  mimeType,
  sizeBytes,
}: {
  bucket: string;
  documentId: string;
  error: unknown;
  key: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<void> {
  try {
    await deleteArtifact(key, bucket);
  } catch (cleanupError) {
    log.error(
      "[attachments-service] Failed to clean up inline image attachment after DB persistence failure",
      {
        cleanupError: getSafeAttachmentStorageErrorMessage(cleanupError),
        documentId,
        error: getSafeAttachmentStorageErrorMessage(error),
        mimeType,
        recoveryMode: ATTACHMENT_ORPHAN_RECOVERY_MODE,
        reconcileAfterSeconds: ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS,
        reason: "inline_image_cleanup_failed",
        sizeBytes,
      }
    );
  }
}
