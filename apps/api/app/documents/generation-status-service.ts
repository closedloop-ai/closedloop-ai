import type { GenerationStatus } from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import {
  fetchBestGenerationStatusForDocument,
  getDismissedFailureRunKey,
  suppressDismissedFailure,
} from "./generation-status-helpers";

/**
 * Document generation-status service.
 *
 * Owns single-document generation-status reads. Status is derived from `loop`
 * rows for the document; `pickBestStatus` reconciles them with
 * active > terminal > none semantics.
 *
 * Failures dismissed before ISS-5547 removed the dismiss surface (rows in
 * `documentGenerationStatusDismissal`) stay suppressed once per `runKey`, so
 * an already-dismissed FAILURE never reappears.
 *
 * Returns `null` when the document doesn't exist in the caller's
 * organization — routes map that to a 404 directly.
 */
export const documentGenerationStatusService = {
  /**
   * Resolve the active generation status for a document from its Loop records,
   * then suppress any user-dismissed failure.
   */
  async getGenerationStatus(
    documentId: string,
    organizationId: string
  ): Promise<GenerationStatus | null> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id: documentId, organizationId },
        select: { id: true, type: true },
      })
    );

    if (!artifact || artifact.type !== ArtifactType.DOCUMENT) {
      return null;
    }

    const status = await fetchBestGenerationStatusForDocument(artifact.id);
    const dismissedRunKey = await getDismissedFailureRunKey(artifact.id);

    return suppressDismissedFailure(status, dismissedRunKey);
  },
};
