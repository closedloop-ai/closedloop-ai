import {
  CreateDocumentErrorCode,
  type CreateDocumentErrorCode as CreateDocumentErrorCodeType,
  type CreatedDocumentInlineImage,
  type Document,
} from "@repo/api/src/types/document";
import type { CreatedDocumentVersionInlineImage } from "@repo/api/src/types/document-version";
import { withDb } from "@repo/database";
import { cleanupCreatedInlineImages } from "./document-inline-image-helpers";
import { sanitizeAndLog } from "./sanitize-content";

/**
 * Create-document inline-image side-effect helpers (ISS-4397 extraction).
 *
 * The seed-content persistence and failure-cleanup steps that
 * `documentService.createWithInlineImages` composes with live here, split out of
 * `document-service.ts` (grandfathered over the 1,000-line ceiling) so that file
 * shrinks as it changes. These are the create-path counterparts to the generic
 * placeholder/attachment helpers in `document-inline-image-helpers.ts`.
 *
 * The document-delete step is injected (`deleteDocument`) rather than imported so
 * this module does not depend on the `documentService` composition root, keeping
 * the import graph acyclic.
 */

const LOG_SCOPE = "[document-service]";

/**
 * Error codes surfaced by the create-with-inline-images placeholder validation.
 * A stable subset of {@link CreateDocumentErrorCode} keyed by the fields
 * `validateInlineImagesBeforeSideEffects` reports.
 */
export const createDocumentInlineImageErrorCodes = {
  DuplicateInlineImagePlaceholder:
    CreateDocumentErrorCode.DuplicateInlineImagePlaceholder,
  ExpandedContentTooLarge: CreateDocumentErrorCode.ExpandedContentTooLarge,
  MissingInlineImagePlaceholder:
    CreateDocumentErrorCode.MissingInlineImagePlaceholder,
  OverlappingInlineImagePlaceholder:
    CreateDocumentErrorCode.OverlappingInlineImagePlaceholder,
} as const;

export type InlineImageDocumentCleanupResult = {
  documentFailed: boolean;
  documentSkipped: boolean;
  failed: boolean;
  failedAttachmentCount: number;
};

/**
 * Overwrite the seeded v1 version content (org-scoped) with the placeholder-
 * resolved body. Returns the persisted content on success, or `null` when the
 * document detail is missing or the update did not land — the caller treats null
 * as a failure and triggers cleanup. Fail-closed: any thrown DB error resolves to
 * null rather than propagating.
 */
export async function updateInitialDocumentVersionContent(
  documentId: string,
  organizationId: string,
  content: string
): Promise<string | null> {
  try {
    const sanitizedContent = sanitizeAndLog(content, documentId);
    return await withDb.tx(async (tx) => {
      const documentDetail = await tx.documentDetail.findFirst({
        where: { artifactId: documentId, artifact: { organizationId } },
        select: { artifactId: true },
      });
      if (!documentDetail) {
        return null;
      }

      const updated = await tx.documentVersion.updateMany({
        where: { documentId, version: 1 },
        data: { content: sanitizedContent },
      });
      return updated.count === 1 ? sanitizedContent : null;
    });
  } catch {
    return null;
  }
}

/**
 * Roll back a partially-created inline-image document: delete the created
 * attachments first, and only when they all clean up delete the document itself.
 * If attachment cleanup fails, the document delete is skipped (leaving a
 * recoverable record) and the partial failure is reported to the caller.
 */
export async function cleanupFailedInlineImageDocument({
  createdDocument,
  createdImages,
  organizationId,
  reason,
  userId,
  deleteDocument,
}: {
  createdDocument: Document;
  createdImages: CreatedDocumentVersionInlineImage[];
  organizationId: string;
  reason: CreateDocumentErrorCodeType;
  userId: string;
  deleteDocument: (
    documentId: string,
    organizationId: string
  ) => Promise<boolean>;
}): Promise<InlineImageDocumentCleanupResult> {
  const attachmentCleanup = await cleanupCreatedInlineImages({
    createdImages,
    documentId: createdDocument.id,
    logScope: LOG_SCOPE,
    organizationId,
    reason,
    userId,
  });
  if (attachmentCleanup.failedCount > 0) {
    return {
      documentFailed: false,
      documentSkipped: true,
      failed: true,
      failedAttachmentCount: attachmentCleanup.failedCount,
    };
  }

  const documentDeleted = await deleteDocument(
    createdDocument.id,
    organizationId
  );
  const documentFailed = !documentDeleted;
  return {
    documentFailed,
    documentSkipped: false,
    failed: attachmentCleanup.failedCount > 0 || documentFailed,
    failedAttachmentCount: attachmentCleanup.failedCount,
  };
}

/** Map a persisted version inline image to the create-document response shape. */
export function toCreatedDocumentInlineImage(
  inlineImage: CreatedDocumentVersionInlineImage
): CreatedDocumentInlineImage {
  return {
    attachmentId: inlineImage.attachmentId,
    attachmentRef: inlineImage.attachmentRef,
    markdownImage: inlineImage.markdownImage,
    placeholder: inlineImage.placeholder,
  };
}
