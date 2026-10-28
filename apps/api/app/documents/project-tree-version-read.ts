import { ArtifactType } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { chunksOf } from "@/lib/chunks-of";

const DOCUMENT_VERSION_READ_CHUNK_SIZE = 1000;

/** Optional, batched version enrichment over the tree's already-authorized IDs. */
export async function fetchDocumentVersionsByArtifact(
  organizationId: string,
  artifactIds: readonly string[]
): Promise<Map<string, number>> {
  const versions = new Map<string, number>();
  const ids = [...new Set(artifactIds)];
  try {
    for (const chunk of chunksOf(ids, DOCUMENT_VERSION_READ_CHUNK_SIZE)) {
      const rows = await withDb((db) =>
        db.documentDetail.findMany({
          where: {
            artifactId: { in: chunk },
            artifact: { organizationId, type: ArtifactType.Document },
          },
          select: { artifactId: true, latestVersion: true },
        })
      );
      for (const row of rows) {
        if (!Number.isSafeInteger(row.latestVersion) || row.latestVersion < 1) {
          throw new Error(
            `Invalid document version for artifact ${row.artifactId}`
          );
        }
        versions.set(row.artifactId, row.latestVersion);
      }
    }
    return versions;
  } catch (error) {
    log.warn("telemetry.enrichment_failed", {
      enrichmentKind: "project_tree_document_versions",
      error: parseError(error),
      organizationId,
      artifactCount: ids.length,
      errorClass:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return new Map();
  }
}
