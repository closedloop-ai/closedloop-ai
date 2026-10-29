import "server-only";
import { createId } from "@paralleldrive/cuid2";
import type {
  AttachmentDownloadResponse,
  AttachmentPurpose as AttachmentPurposeType,
  AttachmentUploadError as AttachmentUploadErrorType,
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
import { ArtifactType, withDb } from "@repo/database";
import { BoundedMap } from "@repo/lib/bounded-map";
import { log } from "@repo/observability/log";
import {
  type RecordWriteInTransaction,
  writeRecorded,
} from "@/lib/record-write-in-transaction";
import {
  ATTACHMENT_UPLOAD_LIMIT_BUCKET,
  ATTACHMENT_UPLOAD_LIMIT_MAX_REQUESTS,
  ATTACHMENT_UPLOAD_LIMIT_WINDOW_MS,
  consumeAttachmentUploadLimit,
} from "./attachment-upload-rate-limit";

/**
 * Convert a Prisma FileAttachment record to the API FileAttachment type.
 * createdAt is serialized to ISO 8601 string.
 */
export function toFileAttachment(record: {
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
export async function requireDocument(
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
    throw new Error(DOCUMENT_NOT_FOUND_ERROR);
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
      url: await getCachedSignedDownloadUrl(
        r.key,
        SIGNED_URL_EXPIRY_SECONDS,
        r.bucket
      ).catch(() => undefined),
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
// Stop reusing a cached presigned URL this long before it actually expires so a
// URL handed to a browser still has comfortable lifetime remaining.
const SIGNED_URL_CACHE_SAFETY_MARGIN_MS = 5 * 60 * 1000;
// Opportunistic upper bound on the per-process signed-URL cache so a long-lived
// worker that signs many distinct objects cannot grow it without limit.
const SIGNED_URL_CACHE_MAX_ENTRIES = 10_000;
export const ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS = 900;
export const INVALID_INLINE_ATTACHMENT_UPLOAD_ERROR =
  "Invalid inline attachment upload";
export const ATTACHMENT_NOT_FOUND_ERROR = "Attachment not found";
export const DOCUMENT_NOT_FOUND_ERROR = "Document not found";

/**
 * Upper bound on attachments returned by the general document listing
 * (`listByDocument`). The UI listing has no pagination and must show a
 * document's full attachment set in normal use, but it is still bounded so a
 * document with thousands of bulk-uploaded attachments cannot return every row
 * to the client.
 */
export const ATTACHMENT_LISTING_MAX_FILES = 200;

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
  recordCreated?: RecordWriteInTransaction<{ attachmentId: string }>;
};

type RequestUploadResult = ServiceResult<
  CreateAttachmentResponse,
  AttachmentUploadErrorType
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

type DeleteAttachmentResult = ServiceResult<void, DeleteAttachmentError>;

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

export function isDocumentNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message === DOCUMENT_NOT_FOUND_ERROR;
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

type CachedSignedDownloadUrl = { url: string; expiresAtMs: number };

/**
 * Per-process, bounded cache of presigned GET URLs keyed by (bucket, expiry,
 * key). The underlying attachment objects are immutable, so reusing a still-valid
 * signature across repeated document list/poll calls keeps the browser-facing
 * previewUrl string stable — the browser can then serve the image bytes from its
 * own HTTP cache instead of re-downloading them from S3 (per-request egress) on
 * every refresh. A cached signature is reused only while more than
 * SIGNED_URL_CACHE_SAFETY_MARGIN_MS of its real lifetime remains, so a URL handed
 * to a client always has comfortable headroom left.
 */
const signedDownloadUrlCache = new BoundedMap<string, CachedSignedDownloadUrl>(
  SIGNED_URL_CACHE_MAX_ENTRIES
);

/**
 * Return a presigned GET URL for an immutable object together with the real
 * expiry of that signature, reusing a cached signature while it remains
 * comfortably valid (more than the safety margin from expiry). Callers that
 * surface the URL's expiry to a client must use this entry's `expiresAtMs`
 * rather than recomputing `now + lifetime`, because a reused signature expires
 * earlier than a freshly minted one.
 */
async function getCachedSignedDownloadEntry(
  key: string,
  expiresInSeconds: number,
  bucket: string
): Promise<CachedSignedDownloadUrl> {
  // Positional JSON encoding so a bucket or key that contains the delimiter
  // cannot collapse two distinct (bucket, ttl, key) tuples onto one cache
  // entry, which would serve a presigned URL for the wrong object.
  const cacheKey = JSON.stringify([bucket, expiresInSeconds, key]);
  const now = Date.now();

  const cached = signedDownloadUrlCache.get(cacheKey);
  if (cached && cached.expiresAtMs - SIGNED_URL_CACHE_SAFETY_MARGIN_MS > now) {
    return cached;
  }

  const url = await getSignedDownloadUrl(key, expiresInSeconds, bucket);
  const entry: CachedSignedDownloadUrl = {
    url,
    expiresAtMs: now + expiresInSeconds * 1000,
  };
  signedDownloadUrlCache.set(cacheKey, entry);
  return entry;
}

/**
 * Return just the presigned GET URL for an immutable object, reusing a cached
 * signature while it remains comfortably valid. Use
 * {@link getCachedSignedDownloadEntry} instead when the caller reports the
 * URL's expiry to a client.
 */
async function getCachedSignedDownloadUrl(
  key: string,
  expiresInSeconds: number,
  bucket: string
): Promise<string> {
  const entry = await getCachedSignedDownloadEntry(
    key,
    expiresInSeconds,
    bucket
  );
  return entry.url;
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
    purpose: AttachmentPurposeType = AttachmentPurpose.Context,
    recordCreated?: RecordWriteInTransaction<{ attachmentId: string }>
  ): Promise<CreateAttachmentResponse> {
    const result = await requestUploadWithOptionalLimit({
      documentId,
      filename,
      mimeType,
      options: { recordCreated },
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
    purpose: AttachmentPurposeType = AttachmentPurpose.Context,
    recordCreated?: RecordWriteInTransaction<{ attachmentId: string }>
  ): Promise<RequestUploadResult> {
    return requestUploadWithOptionalLimit({
      documentId,
      filename,
      mimeType,
      options: { consumeDirectUploadLimit: true, recordCreated },
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
        take: ATTACHMENT_LISTING_MAX_FILES,
        select: ATTACHMENT_LISTING_SELECT,
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
        select: { bucket: true, filename: true, key: true },
      })
    );

    if (!attachment) {
      throw new Error(ATTACHMENT_NOT_FOUND_ERROR);
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
    options: DeleteAttachmentOptions = {},
    recordDeleted?: RecordWriteInTransaction<{ attachmentId: string }>
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
      await recordDeleted?.(tx, { attachmentId });
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
        // Use the cached signature's real expiry, not `now + lifetime`: a reused
        // cached URL expires earlier than a freshly minted one, so recomputing
        // the expiry here would overstate how long the returned URL stays valid.
        const signed = await getCachedSignedDownloadEntry(
          record.key,
          SIGNED_URL_EXPIRY_SECONDS,
          record.bucket
        );
        images.push({
          attachmentId,
          url: signed.url,
          filename: record.filename,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          expiresAt: new Date(signed.expiresAtMs).toISOString(),
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

  // Signed before the row is written, so a signing failure leaves no row.
  let signed: SignedAttachmentUpload;
  try {
    signed = await signDocumentAttachmentUpload({
      bucket,
      documentId,
      mimeType,
      organizationId,
      sizeBytes,
    });
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
  const { key, uploadUrl, expiresAt } = signed;

  // No transaction unless the caller records the row (ISS-12552 parity).
  const attachmentId = await writeRecorded(
    options.recordCreated,
    () =>
      storeDocumentAttachmentRow({
        bucket,
        documentId,
        filename,
        key,
        mimeType,
        purpose,
        sizeBytes,
        userId,
      }),
    (id) => ({ attachmentId: id })
  );
  const created = { id: attachmentId };

  if (isInlineUpload) {
    log.info("[attachments-service] Inline attachment upload request created", {
      ...inlineUploadMetadata,
      attachmentId: created.id,
    });
  }

  return Result.ok({ attachmentId: created.id, uploadUrl, key, expiresAt });
}

export type InlineImageAttachmentPersistenceRecord = Parameters<
  typeof toFileAttachment
>[0];

/**
 * The columns `toFileAttachment` reads, and nothing else. Typed against its
 * parameter so a field newly read inside the mapper fails `tsc` here instead of
 * arriving `undefined` in an API response.
 */
export const FILE_ATTACHMENT_API_SELECT = {
  id: true,
  artifactId: true,
  filename: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
  createdById: true,
  purpose: true,
} as const satisfies Record<keyof InlineImageAttachmentPersistenceRecord, true>;

/**
 * The listing read additionally needs `bucket`/`key` to presign image previews.
 * The reconcile bookkeeping columns (`reconciledAt`, `reconcileAbsent`) are
 * owned solely by the row-reconcile sweep and stay out of this RETURNING.
 */
const ATTACHMENT_LISTING_SELECT = {
  ...FILE_ATTACHMENT_API_SELECT,
  bucket: true,
  key: true,
} as const;

export const attachmentServiceInternalsForTesting = {
  ATTACHMENT_UPLOAD_LIMIT_BUCKET,
  ATTACHMENT_UPLOAD_LIMIT_MAX_REQUESTS,
  ATTACHMENT_UPLOAD_LIMIT_WINDOW_MS,
  clearSignedDownloadUrlCache: () => signedDownloadUrlCache.clear(),
};

/** A presigned upload for a document attachment whose row is not yet stored. */
export type SignedAttachmentUpload = {
  key: string;
  uploadUrl: string;
  expiresAt: string;
};

/**
 * Signs the upload for a new attachment on `documentId`. Nothing is stored, so
 * a caller can sign before it opens the transaction that writes the row
 * (ISS-12552): an unused URL leaves no object behind.
 */
export async function signDocumentAttachmentUpload(input: {
  bucket: string;
  organizationId: string;
  documentId: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<SignedAttachmentUpload> {
  const key = `attachments/${input.organizationId}/${input.documentId}/${createId()}`;
  const expiresAt = new Date(
    Date.now() + ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS * 1000
  ).toISOString();
  const uploadUrl = await getSignedUploadUrl(
    key,
    input.mimeType,
    ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS,
    input.bucket,
    input.sizeBytes
  );
  return { key, uploadUrl, expiresAt };
}

/**
 * Stores a signed attachment's row. `withDb` joins the caller's transaction
 * when there is one, so the row commits or rolls back with it.
 */
export async function storeDocumentAttachmentRow(input: {
  documentId: string;
  bucket: string;
  key: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  userId: string;
  purpose: AttachmentPurposeType;
}): Promise<string> {
  const row = await withDb((db) =>
    db.fileAttachment.create({
      data: {
        artifactId: input.documentId,
        bucket: input.bucket,
        key: input.key,
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        createdById: input.userId,
        purpose: input.purpose,
      },
      select: { id: true },
    })
  );
  return row.id;
}

/** The configured attachment bucket; throws when storage is not configured. */
export function requireAttachmentBucket(): string {
  const bucket = awsKeys().FILE_ATTACHMENTS_BUCKET;
  if (!bucket) {
    throw new Error("FILE_ATTACHMENTS_BUCKET is not configured");
  }
  return bucket;
}
