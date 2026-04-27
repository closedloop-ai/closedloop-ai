import type { DocumentVersion } from "@repo/api/src/types/document-version";
import { withDb } from "@repo/database";
import { DocumentNotFoundError } from "./document-utils";

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
   * Create a new version of a document with content.
   * Atomically increments latestVersion on the documentDetail and inserts
   * the DocumentVersion row.
   */
  createVersion(
    documentId: string,
    organizationId: string,
    userId: string | null,
    content: string | null
  ): Promise<DocumentVersion> {
    return withDb.tx(async (tx) => {
      const detail = await tx.documentDetail.findFirst({
        where: { artifactId: documentId, artifact: { organizationId } },
        select: { latestVersion: true },
      });

      if (!detail) {
        throw new DocumentNotFoundError(documentId);
      }

      const nextVersion = detail.latestVersion + 1;

      const [version] = await Promise.all([
        tx.documentVersion.create({
          data: {
            documentId,
            version: nextVersion,
            content,
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
};
