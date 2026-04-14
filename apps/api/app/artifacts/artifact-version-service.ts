import type { ArtifactVersion } from "@repo/api/src/types/artifact-version";
import { withDb } from "@repo/database";
import { ArtifactNotFoundError } from "./artifact-utils";

export const artifactVersionService = {
  /**
   * Get the latest version for an artifact.
   * Fetches the version row where version = artifact.latestVersion.
   */
  async getLatest(artifactId: string): Promise<ArtifactVersion | null> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id: artifactId },
        select: { latestVersion: true },
      })
    );

    if (!artifact) {
      return null;
    }

    return withDb((db) =>
      db.artifactVersion.findUnique({
        where: {
          artifactId_version: {
            artifactId,
            version: artifact.latestVersion,
          },
        },
      })
    );
  },

  /**
   * Get a specific version by number.
   */
  getByVersion(
    artifactId: string,
    version: number
  ): Promise<ArtifactVersion | null> {
    return withDb((db) =>
      db.artifactVersion.findUnique({
        where: {
          artifactId_version: { artifactId, version },
        },
      })
    );
  },

  /**
   * List all versions for an artifact (without content, for version picker UI).
   */
  listVersions(
    artifactId: string
  ): Promise<
    Pick<
      ArtifactVersion,
      "id" | "artifactId" | "version" | "createdById" | "createdAt"
    >[]
  > {
    return withDb((db) =>
      db.artifactVersion.findMany({
        where: { artifactId },
        select: {
          id: true,
          artifactId: true,
          version: true,
          createdById: true,
          createdAt: true,
        },
        orderBy: { version: "desc" },
      })
    );
  },

  /**
   * Create a new version of an artifact with content.
   * Atomically increments latestVersion on the artifact and inserts the ArtifactVersion row.
   */
  createVersion(
    artifactId: string,
    organizationId: string,
    userId: string | null,
    content: string | null
  ): Promise<ArtifactVersion> {
    return withDb.tx(async (tx) => {
      const artifact = await tx.artifact.findUnique({
        where: { id: artifactId, organizationId },
        select: { latestVersion: true },
      });

      if (!artifact) {
        throw new ArtifactNotFoundError(artifactId);
      }

      const nextVersion = artifact.latestVersion + 1;

      const [version] = await Promise.all([
        tx.artifactVersion.create({
          data: {
            artifactId,
            version: nextVersion,
            content,
            createdById: userId,
          },
        }),
        tx.artifact.update({
          where: { id: artifactId },
          data: { latestVersion: nextVersion },
        }),
      ]);

      return version;
    });
  },
};
