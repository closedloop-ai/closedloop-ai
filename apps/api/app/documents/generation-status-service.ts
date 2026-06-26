import {
  type GenerationStatus,
  getGenerationStatusRunKey,
} from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import { NONE_STATUS } from "@/lib/loops/loop-status-utils";
import {
  fetchBestGenerationStatusForDocument,
  getDismissedFailureRunKey,
  suppressDismissedFailure,
} from "./generation-status-helpers";

/**
 * Document generation-status service.
 *
 * Owns single-document generation-status reads + dismissals. Status is
 * derived from `loop` rows for the document; `pickBestStatus` reconciles them
 * with active > terminal > none semantics.
 *
 * Dismissed failures (rows in `documentGenerationStatusDismissal`) are
 * suppressed once per `runKey` so the same FAILURE state stops surfacing
 * after a user dismisses it.
 *
 * Both methods return `null` when the document doesn't exist in the caller's
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

  /**
   * Dismiss the current FAILURE status for a document. Persisted so all
   * users stop seeing the same failed run. The dismissal applies only when
   * the caller-supplied `expectedRunKey` matches the current failed run's
   * key (or `null` to accept whatever the latest is).
   */
  async dismissGenerationStatus(
    documentId: string,
    organizationId: string,
    userId: string,
    expectedRunKey: string | null
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
    const currentRunKey = status.runKey ?? getGenerationStatusRunKey(status);

    const canDismiss =
      status.status === "FAILURE" &&
      currentRunKey !== null &&
      (expectedRunKey === null || expectedRunKey === currentRunKey);

    if (canDismiss) {
      await withDb((db) =>
        db.documentGenerationStatusDismissal.upsert({
          where: { artifactId: artifact.id },
          create: {
            artifactId: artifact.id,
            dismissedById: userId,
            runKey: currentRunKey,
            dismissedAt: new Date(),
          },
          update: {
            dismissedById: userId,
            runKey: currentRunKey,
            dismissedAt: new Date(),
          },
        })
      );
      return NONE_STATUS;
    }

    const dismissedRunKey = await getDismissedFailureRunKey(artifact.id);
    return suppressDismissedFailure(status, dismissedRunKey);
  },
};
