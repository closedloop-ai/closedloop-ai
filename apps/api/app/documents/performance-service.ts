import type { ExecutionTrace } from "@repo/api/src/types/execution-log";
import type { PerfSummary } from "@repo/api/src/types/performance";
import { ArtifactType, withDb } from "@repo/database";
import { downloadWorkflowArtifacts } from "@repo/github";
import {
  createEmptyExecutionTrace,
  parseExecutionLogs,
} from "@repo/github/execution-log-parser";
import { SYMPHONY_RUN_ARTIFACT_PREFIXES } from "@repo/github/zip-utils";
import { log } from "@repo/observability/log";

/**
 * Document performance service - read paths for execution telemetry.
 *
 * Owns:
 *  - Aggregated PerfSummary rows persisted by workflow completion handlers
 *    (`gitHubActionRunPerformance`).
 *  - Parsed execution traces reconstructed from GitHub workflow artifacts
 *    (downloads + parses agent conversation logs on demand).
 *
 * Both methods return null/empty rather than `Result.err` because callers
 * render an empty state, not a 404.
 */
export const documentPerformanceService = {
  /**
   * Get performance data for a document from the GitHubActionRunPerformance
   * table. Org-scoping is enforced via Prisma relation filter on the artifact
   * FK. Returns null when no performance data is available.
   */
  async getPerformanceData(
    documentId: string,
    organizationId: string
  ): Promise<PerfSummary | null> {
    const perfRecord = await withDb((db) =>
      db.gitHubActionRunPerformance.findFirst({
        where: {
          artifactId: documentId,
          documentDetail: { artifact: { organizationId } },
        },
        orderBy: { createdAt: "desc" },
      })
    );

    if (!perfRecord) {
      return null;
    }

    // Safe cast: summaryData was stored by parsePerfSummary() which always
    // produces a valid PerfSummary shape. Schema drift would require a deploy.
    return perfRecord.summaryData as PerfSummary;
  },

  /**
   * Get execution logs for a document from its associated GitHub Action run.
   * Downloads workflow artifacts and parses agent conversation logs.
   *
   * Returns an empty trace when no run exists, no symphony artifact was
   * uploaded, or the underlying download/parse fails — execution-log is a
   * best-effort UX feature, not a contract endpoint.
   */
  async getExecutionLog(
    documentId: string,
    organizationId: string
  ): Promise<ExecutionTrace> {
    try {
      const artifact = await withDb((db) =>
        db.artifact.findFirst({
          where: {
            id: documentId,
            organizationId,
            type: ArtifactType.DOCUMENT,
          },
          select: { workstreamId: true },
        })
      );

      const workstreamId = artifact?.workstreamId;
      if (!workstreamId) {
        return createEmptyExecutionTrace();
      }

      // Use workstreamId + status to leverage @@index([workstreamId, status])
      // before applying the JSON path filter on triggerData.
      const actionRun = await withDb((db) =>
        db.gitHubActionRun.findFirst({
          where: {
            workstreamId,
            status: "SUCCESS",
            triggerData: {
              path: ["documentId"],
              equals: documentId,
            },
          },
          orderBy: { completedAt: "desc" },
        })
      );

      if (!actionRun?.runId) {
        return createEmptyExecutionTrace();
      }

      const artifacts = await downloadWorkflowArtifacts(actionRun.runId);

      // Find the symphony run artifact (contains .closedloop-ai/runs/ with
      // conversation logs).
      const symphonyArtifact = artifacts.find((a) =>
        SYMPHONY_RUN_ARTIFACT_PREFIXES.some((prefix) =>
          a.name.startsWith(prefix)
        )
      );

      if (!symphonyArtifact) {
        return createEmptyExecutionTrace();
      }

      return parseExecutionLogs(symphonyArtifact.data);
    } catch (error) {
      log.error("[documents-performance] Failed to get execution log", {
        error: error instanceof Error ? error.message : String(error),
      });
      return createEmptyExecutionTrace();
    }
  },
};
