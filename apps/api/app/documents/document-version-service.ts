import type { DocumentDetail } from "@repo/api/src/types/document";
import type { DocumentVersion } from "@repo/api/src/types/document-version";
import { ArtifactType, withDb } from "@repo/database";
import { documentIncludeWithUser, toDocument } from "./document-utils";
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
        select: { latestVersion: true },
      });

      if (!detail) {
        return null;
      }

      const nextVersion = detail.latestVersion + 1;
      const sanitizedContent = sanitizeAndLog(content, documentId);

      const [version] = await Promise.all([
        tx.documentVersion.create({
          data: {
            documentId,
            version: nextVersion,
            content: sanitizedContent,
            createdById: userId,
          },
        }),
        tx.documentDetail.update({
          where: { artifactId: documentId },
          data: { latestVersion: nextVersion },
        }),
      ]);

      return version;
    });
  },

  /**
   * Create a new version of a document and return the refreshed
   * `DocumentDetail` (artifact + new version). Used by the "save edits" path
   * — `versions/route.ts` POST. Returns `null` when the document is missing,
   * not a DOCUMENT artifact, or version creation failed.
   */
  createNewVersion(
    id: string,
    organizationId: string,
    userId: string | null,
    content: string
  ): Promise<DocumentDetail | null> {
    return withDb.tx(async (tx) => {
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
      return { ...toDocument(artifact), version: newVersion };
    });
  },
};
