import type { DocumentVersion } from "@repo/api/src/types/document-version";
import { withDb } from "@repo/database";
import { DocumentNotFoundError } from "./document-utils";

export const documentVersionService = {
  /**
   * Get the latest version for a document.
   * Fetches the version row where version = document.latestVersion.
   */
  async getLatest(documentId: string): Promise<DocumentVersion | null> {
    const document = await withDb((db) =>
      db.document.findUnique({
        where: { id: documentId },
        select: { latestVersion: true },
      })
    );

    if (!document) {
      return null;
    }

    return withDb((db) =>
      db.documentVersion.findUnique({
        where: {
          documentId_version: {
            documentId,
            version: document.latestVersion,
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
   * Create a new version of a document with content.
   * Atomically increments latestVersion on the document and inserts the DocumentVersion row.
   */
  createVersion(
    documentId: string,
    organizationId: string,
    userId: string | null,
    content: string | null
  ): Promise<DocumentVersion> {
    return withDb.tx(async (tx) => {
      const document = await tx.document.findUnique({
        where: { id: documentId, organizationId },
        select: { latestVersion: true },
      });

      if (!document) {
        throw new DocumentNotFoundError(documentId);
      }

      const nextVersion = document.latestVersion + 1;

      const [version] = await Promise.all([
        tx.documentVersion.create({
          data: {
            documentId,
            version: nextVersion,
            content,
            createdById: userId,
          },
        }),
        tx.document.update({
          where: { id: documentId },
          data: { latestVersion: nextVersion },
        }),
      ]);

      return version;
    });
  },
};
