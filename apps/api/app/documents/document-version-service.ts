import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  CreateDocumentVersionErrorCode,
  type CreateDocumentVersionErrorCode as CreateDocumentVersionErrorCodeType,
  type CreateDocumentVersionInlineImageInput,
  type CreatedDocumentVersionInlineImage,
  type DocumentVersion,
  MAX_DOCUMENT_VERSION_INLINE_EXPANDED_CONTENT_CHARS,
} from "@repo/api/src/types/document-version";
import {
  Result,
  type Result as ServiceResult,
} from "@repo/api/src/types/result";
import { ArtifactType, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  buildCreatedInlineImage,
  cleanupCreatedInlineImages,
  createInlineImageAttachmentSafely,
  replaceInlineImagePlaceholders,
  validateInlineImagesBeforeSideEffects,
} from "./document-inline-image-helpers";
import { indexDocumentProjection } from "./document-service";
import { documentIncludeWithUser, toDocument } from "./document-utils";
import type { CreateInlineImageAttachmentError } from "./inline-image-attachment-contract";
import { sanitizeAndLog } from "./sanitize-content";

/**
 * Document version service. Owns version-row CRUD plus the higher-level
 * "save edits" path that returns a refreshed `DocumentDetail` alongside the
 * new version row.
 */
export const documentVersionService = {
  /**
   * Get the latest version for a document.
   * Fetches the version row where version = detail.latestVersion.
   */
  async getLatest(documentId: string): Promise<DocumentVersion | null> {
    const detail = await withDb((db) =>
      db.documentDetail.findUnique({
        where: { artifactId: documentId },
        select: { latestVersion: true },
      })
    );

    if (!detail) {
      return null;
    }

    return withDb((db) =>
      db.documentVersion.findUnique({
        where: {
          documentId_version: {
            documentId,
            version: detail.latestVersion,
          },
        },
      })
    );
  },

  /**
   * Get a specific version by number.
   */
  getByVersion(
    documentId: string,
    version: number
  ): Promise<DocumentVersion | null> {
    return withDb((db) =>
      db.documentVersion.findUnique({
        where: {
          documentId_version: { documentId, version },
        },
      })
    );
  },

  /**
   * List all versions for a document (without content, for version picker UI).
   */
  listVersions(
    documentId: string
  ): Promise<
    Pick<
      DocumentVersion,
      "id" | "documentId" | "version" | "createdById" | "createdAt"
    >[]
  > {
    return withDb((db) =>
      db.documentVersion.findMany({
        where: { documentId },
        select: {
          id: true,
          documentId: true,
          version: true,
          createdById: true,
          createdAt: true,
        },
        orderBy: { version: "desc" },
      })
    );
  },

  /**
   * Create a new version of a document with content. Atomically increments
   * `latestVersion` on the documentDetail and inserts the DocumentVersion
   * row.
   *
   * Returns `null` when no documentDetail is found for `documentId` in the
   * caller's organization (document missing or cross-org). Callers map that
   * to a 404 / no-op as appropriate.
   */
  createVersion(
    documentId: string,
    organizationId: string,
    userId: string | null,
    content: string | null
  ): Promise<DocumentVersion | null> {
    return withDb.tx(async (tx) => {
      const detail = await tx.documentDetail.findFirst({
        where: { artifactId: documentId, artifact: { organizationId } },
        select: { artifactId: true },
      });

      if (!detail) {
        return null;
      }

      // Atomically claim the next version number by incrementing the counter
      // first, then use the returned value for the new row. This avoids the
      // read-then-compute race where two concurrent transactions both read N
      // and both attempt to create version N+1, violating the
      // `@@unique([documentId, version])` constraint.
      const updatedDetail = await tx.documentDetail.update({
        where: { artifactId: documentId },
        data: { latestVersion: { increment: 1 } },
        select: { latestVersion: true },
      });

      const nextVersion = updatedDetail.latestVersion;
      const sanitizedContent = sanitizeAndLog(content, documentId);

      const version = await tx.documentVersion.create({
        data: {
          documentId,
          version: nextVersion,
          content: sanitizedContent,
          createdById: userId,
        },
      });

      // FEA-1626 (wongk review): a content save writes DocumentDetail and
      // DocumentVersion, both of which hang off the artifact — so without this
      // the PARENT `Artifact.updatedAt` never moves, and a two-year-old document
      // edited this morning still reads as two years stale. That is wrong on its
      // own terms (the column claims to be the artifact's last-modified time),
      // and it is what makes `recencyDays` — which windows on `updatedAt` —
      // safe: an artifact someone is actively working can no longer age out from
      // under them. Inside the same transaction as the version insert so the
      // timestamp and the version can never disagree. Set explicitly rather than
      // leaning on Prisma's `@updatedAt`, which needs a real field change to fire.
      await tx.artifact.update({
        where: { id: documentId },
        data: { updatedAt: new Date() },
        select: { id: true },
      });

      return version;
    });
  },

  /**
   * Create a new version of a document and return the refreshed
   * `DocumentDetail` (artifact + new version). Used by the "save edits" path
   * — `versions/route.ts` POST. Returns `null` when the document is missing,
   * not a DOCUMENT artifact, or version creation failed.
   */
  async createNewVersion(
    id: string,
    organizationId: string,
    userId: string | null,
    content: string
  ): Promise<DocumentDetail | null> {
    const detail = await withDb.tx(async (tx) => {
      const newVersion = await documentVersionService.createVersion(
        id,
        organizationId,
        userId,
        content
      );

      const artifact = await tx.artifact.findUnique({
        where: { id, organizationId },
        include: documentIncludeWithUser,
      });

      if (artifact?.type !== ArtifactType.DOCUMENT || !newVersion) {
        return null;
      }
      return {
        ...toDocument(artifact),
        latestVersionContent: newVersion.content,
        version: newVersion,
      };
    });

    // FEA-3863 / Phase-2: content edits go through this save path, so refresh
    // the searchable body here the same way create/metadata-update do —
    // otherwise the search projection body would go stale forever after any
    // content-only save. Best-effort, post-commit, fail-open; pass the
    // just-persisted (sanitized) version content so the index reflects the edit
    // without a follow-up read. Runs outside the transaction so the projection
    // upsert never widens the interactive-transaction window.
    if (detail) {
      indexDocumentProjection(detail, detail.latestVersionContent);
    }
    return detail;
  },

  /**
   * Create inline image attachments and a document version as one compound
   * operation. Newly-created attachments are rolled back if a later image or
   * version step fails.
   */
  async createNewVersionWithInlineImages(
    id: string,
    organizationId: string,
    userId: string,
    content: string,
    inlineImages: CreateDocumentVersionInlineImageInput[]
  ): Promise<CreateDocumentVersionWithInlineImagesResult> {
    const placeholderValidation = validateInlineImagesBeforeSideEffects(
      content,
      inlineImages,
      {
        DuplicateInlineImagePlaceholder:
          CreateDocumentVersionErrorCode.DuplicateInlineImagePlaceholder,
        ExpandedContentTooLarge:
          CreateDocumentVersionErrorCode.ExpandedContentTooLarge,
        MissingInlineImagePlaceholder:
          CreateDocumentVersionErrorCode.MissingInlineImagePlaceholder,
        OverlappingInlineImagePlaceholder:
          CreateDocumentVersionErrorCode.OverlappingInlineImagePlaceholder,
      },
      MAX_DOCUMENT_VERSION_INLINE_EXPANDED_CONTENT_CHARS
    );
    if (!placeholderValidation.ok) {
      return Result.err(placeholderValidation.error);
    }

    const createdImages: CreatedDocumentVersionInlineImage[] = [];
    for (const inlineImage of inlineImages) {
      const imageResult = await createInlineImageAttachmentSafely({
        documentId: id,
        failureReason: CreateDocumentVersionErrorCode.InlineImageCreationFailed,
        inlineImage,
        logScope: "[document-version-service]",
        organizationId,
        userId,
      });
      if (!imageResult.ok) {
        const cleanup = await cleanupCreatedInlineImages({
          createdImages,
          documentId: id,
          logScope: "[document-version-service]",
          organizationId,
          reason: CreateDocumentVersionErrorCode.InlineImageCreationFailed,
          userId,
        });
        return Result.err({
          cleanupFailed: cleanup.failedCount > 0,
          cleanupFailedCount: cleanup.failedCount,
          code: CreateDocumentVersionErrorCode.InlineImageCreationFailed,
          inlineImageError: imageResult.error,
          placeholder: inlineImage.placeholder,
        });
      }

      createdImages.push(
        buildCreatedInlineImage(imageResult.value, inlineImage)
      );
    }

    const versionContent = replaceInlineImagePlaceholders(
      content,
      createdImages
    );

    try {
      const document = await documentVersionService.createNewVersion(
        id,
        organizationId,
        userId,
        versionContent
      );
      if (!document) {
        const cleanup = await cleanupCreatedInlineImages({
          createdImages,
          documentId: id,
          logScope: "[document-version-service]",
          organizationId,
          reason: CreateDocumentVersionErrorCode.DocumentNotFound,
          userId,
        });
        return Result.err({
          cleanupFailed: cleanup.failedCount > 0,
          cleanupFailedCount: cleanup.failedCount,
          code: CreateDocumentVersionErrorCode.DocumentNotFound,
        });
      }
      return Result.ok({
        document,
        inlineImages: createdImages,
        versionContent,
      });
    } catch (error) {
      const cleanup = await cleanupCreatedInlineImages({
        createdImages,
        documentId: id,
        logScope: "[document-version-service]",
        organizationId,
        reason: CreateDocumentVersionErrorCode.VersionCreationFailed,
        userId,
      });
      log.error("[document-version-service] Inline image version failed", {
        cleanupFailedCount: cleanup.failedCount,
        documentId: id,
        error: getSafeVersionErrorMessage(error),
        organizationId,
        reason: CreateDocumentVersionErrorCode.VersionCreationFailed,
      });
      return Result.err({
        cleanupFailed: cleanup.failedCount > 0,
        cleanupFailedCount: cleanup.failedCount,
        code: CreateDocumentVersionErrorCode.VersionCreationFailed,
      });
    }
  },
};

export type CreateDocumentVersionError = {
  code: CreateDocumentVersionErrorCodeType;
  placeholder?: string;
  inlineImageError?: CreateInlineImageAttachmentError;
  cleanupFailed?: boolean;
  cleanupFailedCount?: number;
  estimatedContentChars?: number;
  maxContentChars?: number;
  requestBodyBytes?: number;
  maxBytes?: number;
};

type CreateDocumentVersionWithInlineImagesResult = ServiceResult<
  {
    document: DocumentDetail;
    versionContent: string;
    inlineImages: CreatedDocumentVersionInlineImage[];
  },
  CreateDocumentVersionError
>;

function getSafeVersionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
