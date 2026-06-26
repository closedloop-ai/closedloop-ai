import "server-only";

import { randomUUID } from "node:crypto";
import type { ContextPackAttachmentSchema } from "@closedloop-ai/loops-api/context-pack";
import { createId } from "@paralleldrive/cuid2";
import type {
  AttachmentDownloadResponse,
  AttachmentPurpose as AttachmentPurposeType,
  CreateAttachmentResponse,
  FileAttachment,
  ResolveInlineImagesResponse,
} from "@repo/api/src/types/attachment";
import {
  AttachmentPurpose,
  AttachmentPurposeSelector,
  type AttachmentPurposeSelector as AttachmentPurposeSelectorType,
  InlineImageResolveSkipReason,
  isImageMimeType,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
} from "@repo/api/src/types/attachment";
import {
  Result,
  type Result as ServiceResult,
} from "@repo/api/src/types/result";
import {
  deleteArtifact,
  getSignedDownloadUrl,
  getSignedDownloadUrlWithDisposition,
  getSignedUploadUrl,
} from "@repo/aws";
import { keys as awsKeys } from "@repo/aws/keys";
import { ArtifactType, type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import type { z } from "zod";
import { getPrismaErrorCode } from "@/lib/db-utils";

/**
 * Convert a Prisma FileAttachment record to the API FileAttachment type.
 * createdAt is serialized to ISO 8601 string.
 */
function toFileAttachment(record: {
  id: string;
  artifactId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
  createdById: string;
  purpose?: string | null;
}): FileAttachment {
  return {
    id: record.id,
    artifactId: record.artifactId ?? "",
    filename: record.filename,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt.toISOString(),
    createdById: record.createdById,
    purpose: normalizeAttachmentPurpose(record.purpose),
  };
}

/**
 * Verify a document artifact exists and belongs to the given org.
 * Throws "Document not found" if missing or org-mismatched.
 */
async function requireDocument(
  documentId: string,
  organizationId: string
): Promise<{ id: string }> {
  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: {
        id: documentId,
        organizationId,
        type: ArtifactType.DOCUMENT,
      },
      select: { id: true },
    })
  );

  if (!artifact) {
    throw new Error("Document not found");
  }
  return artifact;
}

/**
 * Populate inline preview URLs on image attachments in-place.
 * Non-image attachments and S3 errors are silently skipped.
 */
async function populatePreviewUrls(
  records: Array<{ id: string; mimeType: string; key: string; bucket: string }>,
  attachments: FileAttachment[]
): Promise<void> {
  const imageRecords = records.filter((r) => isImageMimeType(r.mimeType));
  if (imageRecords.length === 0) {
    return;
  }

  const previewUrls = await Promise.all(
    imageRecords.map(async (r) => ({
      id: r.id,
      url: await getSignedDownloadUrl(r.key, 3600, r.bucket).catch(
        () => undefined
      ),
    }))
  );
  const urlMap = new Map(
    previewUrls.filter((p) => p.url).map((p) => [p.id, p.url])
  );
  for (const attachment of attachments) {
    const url = urlMap.get(attachment.id);
    if (url) {
      attachment.previewUrl = url;
    }
  }
}

const SIGNED_URL_EXPIRY_SECONDS = 3600;
const SIGNED_URL_EXPIRY_MS = SIGNED_URL_EXPIRY_SECONDS * 1000;
const ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS = 900;
const ATTACHMENT_UPLOAD_LIMIT_BUCKET = "document_attachment_upload_request";
const ATTACHMENT_UPLOAD_LIMIT_MAX_REQUESTS = 60;
const ATTACHMENT_UPLOAD_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const INVALID_INLINE_ATTACHMENT_UPLOAD_ERROR =
  "Invalid inline attachment upload";

/** Maximum number of attachments returned by the signed-URL listing methods. */
export const ATTACHMENT_SIGNED_URL_MAX_FILES = 20;

const signedUrlSelect = {
  id: true,
  filename: true,
  mimeType: true,
  sizeBytes: true,
  key: true,
  bucket: true,
} as const;

type SignedUrlRecord = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  key: string;
  bucket: string;
};

type ResolvableInlineImageRecord = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  key: string;
  bucket: string;
  purpose: string | null;
};

type RequestUploadOptions = {
  /**
   * Applies the durable direct-upload abuse limit. Context attachment routes
   * intentionally omit this option so their existing policy and response shape
   * stay unchanged.
   */
  consumeDirectUploadLimit?: boolean;
};

type ContextPackAttachment = z.infer<typeof ContextPackAttachmentSchema>;
type AttachmentUploadLimitClient = Pick<TransactionClient, "oAuthRateLimit">;

export const AttachmentUploadError = {
  RateLimited: "rate_limited",
} as const;
export type AttachmentUploadError = {
  type: (typeof AttachmentUploadError)["RateLimited"];
  retryAfterSeconds: number;
};

export type RequestUploadResult = ServiceResult<
  CreateAttachmentResponse,
  AttachmentUploadError
>;

export const DeleteAttachmentErrorCode = {
  AttachmentNotFound: "attachment_not_found",
  DocumentNotFound: "document_not_found",
  NotOwned: "not_owned",
} as const;

export type DeleteAttachmentErrorCode =
  (typeof DeleteAttachmentErrorCode)[keyof typeof DeleteAttachmentErrorCode];

export type DeleteAttachmentError = {
  code: DeleteAttachmentErrorCode;
};

export type DeleteAttachmentResult = ServiceResult<void, DeleteAttachmentError>;

type DeleteAttachmentOptions = {
  /**
   * Restricts deletion to attachments created by the actor. API-key automation
   * sets this true; first-party session deletes keep the legacy document/org
   * scoped behavior.
   */
  requireCreatorOwnership?: boolean;
};

type AttachmentDeleteRecord = {
  bucket: string;
  createdById: string;
  key: string;
};

function normalizeAttachmentPurpose(
  purpose: string | null | undefined
): AttachmentPurposeType {
  return purpose === AttachmentPurpose.Inline
    ? AttachmentPurpose.Inline
    : AttachmentPurpose.Context;
}

function buildPurposeWhere(purpose: AttachmentPurposeSelectorType) {
  if (purpose === AttachmentPurposeSelector.All) {
    return {};
  }
  return { purpose };
}

function getSafeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isDocumentNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message === "Document not found";
}

function getInlineUploadRejectionReason(
  mimeType: string,
  sizeBytes: number
): string {
  if (!isImageMimeType(mimeType)) {
    return "unsupported_mime";
  }
  if (sizeBytes > MAX_ATTACHMENT_FILE_SIZE_BYTES) {
    return "file_too_large";
  }
  return "invalid_inline_upload";
}

function countInlineImageSkipReasons(
  skipped: ResolveInlineImagesResponse["skipped"]
): Record<string, number> {
  return skipped.reduce<Record<string, number>>((counts, item) => {
    counts[item.reason] = (counts[item.reason] ?? 0) + 1;
    return counts;
  }, {});
}

async function consumeAttachmentUploadLimit(
  organizationId: string,
  documentId: string
): Promise<ServiceResult<void, AttachmentUploadError>> {
  const now = new Date();
  const subject = `${organizationId}:${documentId}`;
  const windowExpiresAt = new Date(
    now.getTime() + ATTACHMENT_UPLOAD_LIMIT_WINDOW_MS
  );

  const consumeExistingWindow = async (
    db: AttachmentUploadLimitClient,
    record: {
      id: string;
      requestCount: number;
      windowExpiresAt: Date;
    }
  ): Promise<ServiceResult<void, AttachmentUploadError>> => {
    const updateResult = await db.oAuthRateLimit.updateMany({
      where: {
        id: record.id,
        requestCount: { lt: ATTACHMENT_UPLOAD_LIMIT_MAX_REQUESTS },
        windowExpiresAt: { gt: now },
      },
      data: { requestCount: { increment: 1 } },
    });
    if (updateResult.count === 1) {
      return Result.ok(undefined);
    }

    const latestRecord = await db.oAuthRateLimit.findUnique({
      where: {
        bucket_subject: {
          bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
          subject,
        },
      },
    });
    if (!latestRecord) {
      throw new Error("Attachment upload limiter row disappeared");
    }
    if (latestRecord.windowExpiresAt <= now) {
      return resetExpiredWindow(db, latestRecord);
    }

    return Result.err({
      type: AttachmentUploadError.RateLimited,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(
          (latestRecord.windowExpiresAt.getTime() - now.getTime()) / 1000
        )
      ),
    });
  };

  const resetExpiredWindow = async (
    db: AttachmentUploadLimitClient,
    record: {
      id: string;
      windowExpiresAt: Date;
    }
  ): Promise<ServiceResult<void, AttachmentUploadError>> => {
    const resetResult = await db.oAuthRateLimit.updateMany({
      where: {
        id: record.id,
        windowExpiresAt: { lte: now },
      },
      data: {
        requestCount: 1,
        windowStartedAt: now,
        windowExpiresAt,
      },
    });
    if (resetResult.count === 1) {
      return Result.ok(undefined);
    }

    const latestRecord = await db.oAuthRateLimit.findUnique({
      where: {
        bucket_subject: {
          bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
          subject,
        },
      },
    });
    if (!latestRecord) {
      throw new Error("Attachment upload limiter row disappeared");
    }
    if (latestRecord.windowExpiresAt <= now) {
      return resetExpiredWindow(db, latestRecord);
    }
    return consumeExistingWindow(db, latestRecord);
  };

  await withDb((db) =>
    cleanupExpiredAttachmentUploadLimitRows(db, subject, now)
  );

  try {
    return await withDb.tx(async (db) => {
      const record = await db.oAuthRateLimit.findUnique({
        where: {
          bucket_subject: {
            bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
            subject,
          },
        },
      });

      if (!record) {
        await db.oAuthRateLimit.create({
          data: {
            id: randomUUID(),
            bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
            subject,
            requestCount: 1,
            windowStartedAt: now,
            windowExpiresAt,
          },
        });
        return Result.ok(undefined);
      }

      if (record.windowExpiresAt <= now) {
        return resetExpiredWindow(db, record);
      }
      return consumeExistingWindow(db, record);
    });
  } catch (error) {
    if (getPrismaErrorCode(error) !== "P2002") {
      throw error;
    }

    // A failed create can poison Prisma's interactive transaction, so recover
    // from the first-window race after rollback in a fresh transaction.
    return await withDb.tx(async (db) => {
      const racedRecord = await db.oAuthRateLimit.findUnique({
        where: {
          bucket_subject: {
            bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
            subject,
          },
        },
      });
      if (!racedRecord) {
        throw error;
      }
      if (racedRecord.windowExpiresAt <= now) {
        return resetExpiredWindow(db, racedRecord);
      }
      return consumeExistingWindow(db, racedRecord);
    });
  }
}

/**
 * Clears stale limiter rows without blocking the upload path. The active
 * subject is excluded so its expired row can be reset atomically by the caller.
 */
async function cleanupExpiredAttachmentUploadLimitRows(
  db: AttachmentUploadLimitClient,
  subject: string,
  now: Date
): Promise<void> {
  try {
    await db.oAuthRateLimit.deleteMany({
      where: {
        bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
        subject: { not: subject },
        windowExpiresAt: { lt: now },
      },
    });
  } catch (error) {
    log.warn(
      "[attachments-service] Failed to clean up expired attachment upload limiter rows",
      {
        bucket: ATTACHMENT_UPLOAD_LIMIT_BUCKET,
        error: getSafeErrorMessage(error),
      }
    );
  }
}

/**
 * Enforce the inline-image upload contract at the storage owner boundary so
 * route validators and future internal callers cannot drift apart.
 */
function assertInlineUploadIsAllowed({
  documentId,
  mimeType,
  purpose,
  sizeBytes,
}: {
  documentId: string;
  mimeType: string;
  purpose: AttachmentPurposeType;
  sizeBytes: number;
}): void {
  if (purpose !== AttachmentPurpose.Inline) {
    return;
  }
  if (
    !(isImageMimeType(mimeType) && sizeBytes <= MAX_ATTACHMENT_FILE_SIZE_BYTES)
  ) {
    log.warn("[attachments-service] Inline attachment upload rejected", {
      documentId,
      mimeType,
      purpose,
      reason: getInlineUploadRejectionReason(mimeType, sizeBytes),
      sizeBytes,
    });
    throw new Error(INVALID_INLINE_ATTACHMENT_UPLOAD_ERROR);
  }
}

/**
 * Convert attachment records to ContextPackAttachment entries with presigned download URLs.
 */
async function toContextPackAttachments(
  records: SignedUrlRecord[]
): Promise<ContextPackAttachment[]> {
  const results = await Promise.allSettled(
    records.map(async (record) => ({
      id: record.id,
      filename: record.filename,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      signedUrl: await getSignedDownloadUrl(
        record.key,
        SIGNED_URL_EXPIRY_SECONDS,
        record.bucket
      ),
      signedUrlExpiresAt: new Date(
        Date.now() + SIGNED_URL_EXPIRY_MS
      ).toISOString(),
    }))
  );

  const attachments: ContextPackAttachment[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      attachments.push(result.value);
    } else {
      log.warn(
        "[attachments-service] Failed to sign attachment URL, skipping",
        {
          error: result.reason,
        }
      );
    }
  }
  return attachments;
}

export const attachmentsService = {
  /**
   * Initiate a file upload for a document.
   * Returns a presigned S3 upload URL and the attachment record ID.
   * The caller should PUT the file directly to the upload URL.
   */
  async requestUpload(
    documentId: string,
    organizationId: string,
    userId: string,
    filename: string,
    mimeType: string,
    sizeBytes: number,
    purpose: AttachmentPurposeType = AttachmentPurpose.Context
  ): Promise<CreateAttachmentResponse> {
    const result = await requestUploadWithOptionalLimit({
      documentId,
      filename,
      mimeType,
      options: {},
      organizationId,
      purpose,
      sizeBytes,
      userId,
    });
    if (!result.ok) {
      throw new Error("Attachment upload rate limit exceeded");
    }
    return result.value;
  },

  /**
   * Initiate a direct document attachment upload and return expected limiter
   * outcomes as a service Result for route-level HTTP mapping.
   */
  requestDirectUpload(
    documentId: string,
    organizationId: string,
    userId: string,
    filename: string,
    mimeType: string,
    sizeBytes: number,
    purpose: AttachmentPurposeType = AttachmentPurpose.Context
  ): Promise<RequestUploadResult> {
    return requestUploadWithOptionalLimit({
      documentId,
      filename,
      mimeType,
      options: { consumeDirectUploadLimit: true },
      organizationId,
      purpose,
      sizeBytes,
      userId,
    });
  },

  /**
   * List all attachments for a document (org-scoped, newest first).
   */
  async listByDocument(
    documentId: string,
    organizationId: string,
    purpose: AttachmentPurposeSelectorType = AttachmentPurposeSelector.Context
  ): Promise<FileAttachment[]> {
    await requireDocument(documentId, organizationId);

    const records = await withDb((db) =>
      db.fileAttachment.findMany({
        where: {
          artifactId: documentId,
          artifact: { organizationId },
          ...buildPurposeWhere(purpose),
        },
        orderBy: { createdAt: "desc" },
      })
    );

    const attachments = records.map(toFileAttachment);
    await populatePreviewUrls(records, attachments);
    return attachments;
  },

  /**
   * Generate a presigned download URL for an attachment.
   * Forces browser download via Content-Disposition: attachment.
   */
  async getDownloadUrl(
    documentId: string,
    organizationId: string,
    attachmentId: string
  ): Promise<AttachmentDownloadResponse> {
    await requireDocument(documentId, organizationId);

    const attachment = await withDb((db) =>
      db.fileAttachment.findFirst({
        where: { id: attachmentId, artifactId: documentId },
      })
    );

    if (!attachment) {
      throw new Error("Attachment not found");
    }

    const downloadUrl = await getSignedDownloadUrlWithDisposition(
      attachment.key,
      attachment.filename,
      3600,
      attachment.bucket
    );

    return { downloadUrl };
  },

  async deleteAttachment(
    documentId: string,
    organizationId: string,
    actorUserId: string,
    attachmentId: string,
    options: DeleteAttachmentOptions = {}
  ): Promise<DeleteAttachmentResult> {
    try {
      await requireDocument(documentId, organizationId);
    } catch (error) {
      if (isDocumentNotFoundError(error)) {
        return Result.err({
          code: DeleteAttachmentErrorCode.DocumentNotFound,
        });
      }
      throw error;
    }

    const result = await withDb.tx(async (tx) => {
      const record = await tx.fileAttachment.findFirst({
        where: { id: attachmentId, artifactId: documentId },
        select: { bucket: true, createdById: true, key: true },
      });

      if (!record) {
        return Result.err<AttachmentDeleteRecord, DeleteAttachmentError>({
          code: DeleteAttachmentErrorCode.AttachmentNotFound,
        });
      }

      if (
        options.requireCreatorOwnership === true &&
        record.createdById !== actorUserId
      ) {
        return Result.err<AttachmentDeleteRecord, DeleteAttachmentError>({
          code: DeleteAttachmentErrorCode.NotOwned,
        });
      }

      const deleted = await tx.fileAttachment.deleteMany({
        where: {
          artifactId: documentId,
          id: attachmentId,
          ...(options.requireCreatorOwnership === true
            ? { createdById: actorUserId }
            : {}),
        },
      });
      if (deleted.count === 0) {
        return Result.err<AttachmentDeleteRecord, DeleteAttachmentError>({
          code: DeleteAttachmentErrorCode.AttachmentNotFound,
        });
      }
      return Result.ok<AttachmentDeleteRecord, DeleteAttachmentError>(record);
    });

    if (result.ok === false) {
      return result;
    }

    const attachment = result.value;
    try {
      await deleteArtifact(attachment.key, attachment.bucket);
    } catch (error) {
      log.error("[attachments-service] Failed to delete S3 object", {
        attachmentId,
        documentId,
        error: getSafeErrorMessage(error),
        organizationId,
      });
    }
    return Result.ok(undefined);
  },

  /**
   * Resolve document-scoped inline image attachment IDs to fresh signed URLs.
   * Returns per-ID skip diagnostics instead of failing the whole request.
   */
  async resolveInlineImages(
    documentId: string,
    organizationId: string,
    attachmentIds: string[]
  ): Promise<ResolveInlineImagesResponse> {
    const uniqueIds = [...new Set(attachmentIds)];
    const resolveMetadata = {
      documentId,
      requestedCount: attachmentIds.length,
      uniqueCount: uniqueIds.length,
    };
    log.info(
      "[attachments-service] Inline image resolve request started",
      resolveMetadata
    );

    try {
      await requireDocument(documentId, organizationId);
    } catch (error) {
      if (isDocumentNotFoundError(error)) {
        log.warn(
          "[attachments-service] Inline image resolve document not found",
          {
            ...resolveMetadata,
            reason: "document_not_found",
          }
        );
      }
      throw error;
    }

    if (uniqueIds.length === 0) {
      log.info("[attachments-service] Inline image resolve request completed", {
        ...resolveMetadata,
        resolvedCount: 0,
        skippedCount: 0,
        skipReasonCounts: {},
      });
      return { images: [], skipped: [] };
    }

    let records: unknown[];
    try {
      records = await withDb((db) =>
        db.fileAttachment.findMany({
          where: {
            id: { in: uniqueIds },
            artifactId: documentId,
            artifact: { organizationId },
          },
          select: {
            id: true,
            filename: true,
            mimeType: true,
            sizeBytes: true,
            key: true,
            bucket: true,
            purpose: true,
          },
        })
      );
    } catch (error) {
      log.error("[attachments-service] Inline image resolve request failed", {
        ...resolveMetadata,
        error: getSafeErrorMessage(error),
        reason: "attachment_lookup_failed",
      });
      throw error;
    }

    const recordsById = new Map(
      (records as ResolvableInlineImageRecord[]).map((record) => [
        record.id,
        record,
      ])
    );
    const images: ResolveInlineImagesResponse["images"] = [];
    const skipped: ResolveInlineImagesResponse["skipped"] = [];

    for (const attachmentId of uniqueIds) {
      const record = recordsById.get(attachmentId);
      if (!record) {
        skipped.push({
          attachmentId,
          reason: InlineImageResolveSkipReason.NotFound,
        });
        continue;
      }

      if (
        normalizeAttachmentPurpose(record.purpose) !== AttachmentPurpose.Inline
      ) {
        skipped.push({
          attachmentId,
          reason: InlineImageResolveSkipReason.NotInline,
        });
        continue;
      }

      if (!isImageMimeType(record.mimeType)) {
        skipped.push({
          attachmentId,
          reason: InlineImageResolveSkipReason.NotImage,
        });
        continue;
      }

      try {
        images.push({
          attachmentId,
          url: await getSignedDownloadUrl(
            record.key,
            SIGNED_URL_EXPIRY_SECONDS,
            record.bucket
          ),
          filename: record.filename,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          expiresAt: new Date(Date.now() + SIGNED_URL_EXPIRY_MS).toISOString(),
        });
      } catch (error) {
        log.warn("[attachments-service] Failed to resolve inline image URL", {
          attachmentId,
          documentId,
          error: getSafeErrorMessage(error),
          mimeType: record.mimeType,
          purpose: normalizeAttachmentPurpose(record.purpose),
          reason: InlineImageResolveSkipReason.SigningFailed,
          sizeBytes: record.sizeBytes,
        });
        skipped.push({
          attachmentId,
          reason: InlineImageResolveSkipReason.SigningFailed,
        });
      }
    }

    log.info("[attachments-service] Inline image resolve request completed", {
      ...resolveMetadata,
      resolvedCount: images.length,
      skippedCount: skipped.length,
      skipReasonCounts: countInlineImageSkipReasons(skipped),
    });

    return { images, skipped };
  },

  /**
   * List all attachments for a document with presigned download URLs (for context pack use).
   */
  async listWithSignedUrlsByDocument(
    documentId: string,
    organizationId: string
  ): Promise<ContextPackAttachment[]> {
    const records = await withDb((db) =>
      db.fileAttachment.findMany({
        where: {
          artifactId: documentId,
          artifact: { organizationId },
          purpose: AttachmentPurpose.Context,
        },
        select: signedUrlSelect,
        orderBy: { createdAt: "desc" },
        take: ATTACHMENT_SIGNED_URL_MAX_FILES,
      })
    );

    return toContextPackAttachments(records);
  },
};

async function requestUploadWithOptionalLimit({
  documentId,
  filename,
  mimeType,
  options,
  organizationId,
  purpose,
  sizeBytes,
  userId,
}: {
  documentId: string;
  organizationId: string;
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  purpose: AttachmentPurposeType;
  options: RequestUploadOptions;
}): Promise<RequestUploadResult> {
  const inlineUploadMetadata = {
    documentId,
    mimeType,
    purpose,
    sizeBytes,
  };
  const isInlineUpload = purpose === AttachmentPurpose.Inline;
  if (isInlineUpload) {
    log.info(
      "[attachments-service] Inline attachment upload request started",
      inlineUploadMetadata
    );
  }

  assertInlineUploadIsAllowed({
    documentId,
    mimeType,
    purpose,
    sizeBytes,
  });

  const bucket = awsKeys().FILE_ATTACHMENTS_BUCKET;
  if (!bucket) {
    if (isInlineUpload) {
      log.error(
        "[attachments-service] Inline attachment upload missing storage bucket",
        {
          ...inlineUploadMetadata,
          reason: "missing_file_attachments_bucket",
        }
      );
    }
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }

  try {
    await requireDocument(documentId, organizationId);
  } catch (error) {
    if (isInlineUpload && isDocumentNotFoundError(error)) {
      log.warn(
        "[attachments-service] Inline attachment upload document not found",
        {
          ...inlineUploadMetadata,
          reason: "document_not_found",
        }
      );
    }
    throw error;
  }

  if (options.consumeDirectUploadLimit) {
    const limitResult = await consumeAttachmentUploadLimit(
      organizationId,
      documentId
    );
    if (limitResult.ok === false) {
      return Result.err(limitResult.error);
    }
  }

  const key = `attachments/${organizationId}/${documentId}/${createId()}`;
  const expiresAt = new Date(
    Date.now() + ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS * 1000
  ).toISOString();

  // Generate presigned URL first; if this fails, no orphaned DB record is created.
  let uploadUrl: string;
  try {
    uploadUrl = await getSignedUploadUrl(
      key,
      mimeType,
      ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS,
      bucket,
      sizeBytes
    );
  } catch (error) {
    if (isInlineUpload) {
      log.error(
        "[attachments-service] Inline attachment upload signing failed",
        {
          ...inlineUploadMetadata,
          error: getSafeErrorMessage(error),
          reason: "signing_failed",
        }
      );
    }
    throw error;
  }

  const created = await withDb((db) =>
    db.fileAttachment.create({
      data: {
        artifactId: documentId,
        bucket,
        key,
        filename,
        mimeType,
        sizeBytes,
        createdById: userId,
        purpose,
      },
    })
  );

  if (isInlineUpload) {
    log.info("[attachments-service] Inline attachment upload request created", {
      ...inlineUploadMetadata,
      attachmentId: created.id,
    });
  }

  return Result.ok({ attachmentId: created.id, uploadUrl, key, expiresAt });
}

export const attachmentServiceInternalsForTesting = {
  ATTACHMENT_UPLOAD_LIMIT_BUCKET,
  ATTACHMENT_UPLOAD_LIMIT_MAX_REQUESTS,
  ATTACHMENT_UPLOAD_LIMIT_WINDOW_MS,
};
