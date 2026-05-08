import type { JsonObject } from "@repo/api/src/types/common";
import type {
  EvaluationReportType,
  JudgesReport,
} from "@repo/api/src/types/evaluation";
import type { Loop } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { documentWhere } from "@/lib/artifact-adapters";
import {
  parseJsonArtifact,
  upsertEvaluationWithJudgeScores,
} from "@/lib/loops/loop-document-ingestion";
import { downloadArtifactFile } from "@/lib/loops/loop-state";
import { judgesReportSchema } from "../judges-report-schema";
import type { LoopCommandHandler } from "./loop-command-handler";
import { defineHandler } from "./loop-command-handler";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JudgesArtifacts = {
  report: JudgesReport | null;
};

export type EvaluationHandlerConfig = {
  /** The S3 filename for the judges report (e.g. "plan-judges.json"). */
  fileName: string;
  /** The key in the uploaded JSON payload (e.g. "planJudges"). */
  uploadKey: string;
  /** Persisted report type discriminator (PLAN, CODE, or PRD). */
  reportType: EvaluationReportType;
  /** Whether the command requires a target repo. */
  requiresRepo: boolean;
  /** Human-readable label for log messages (e.g. "plan", "code", "PRD"). */
  label: string;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEvaluationHandler(
  config: EvaluationHandlerConfig
): LoopCommandHandler {
  const { fileName, uploadKey, reportType, requiresRepo, label } = config;

  return defineHandler<JudgesArtifacts>({
    requiresRepo,
    requiresParent: false,
    includePrimaryArtifact: true,

    async downloadArtifacts(stateKeyPrefix: string) {
      const buf = await downloadArtifactFile(stateKeyPrefix, fileName);
      const report = parseJsonArtifact<JudgesReport>(buf, fileName, (r) =>
        judgesReportSchema.parse(r)
      ) as JudgesReport | null;
      return { report };
    },

    downloadFromUpload(uploaded: JsonObject): JudgesArtifacts {
      const report =
        (judgesReportSchema
          .optional()
          .parse(uploaded?.[uploadKey] ?? undefined) as JudgesReport) ?? null;
      return { report };
    },

    async ingest(
      loop: Loop,
      organizationId: string,
      artifacts: JudgesArtifacts
    ) {
      if (!loop.documentId) {
        log.warn(
          `[loop-document-ingestion] No artifactId on loop, skipping ${label} evaluation ingestion`,
          { loopId: loop.id }
        );
        return;
      }

      const { report } = artifacts;

      if (!report) {
        log.info(
          `[loop-document-ingestion] No ${label} judges report to ingest`,
          { documentId: loop.documentId }
        );
        return;
      }

      const documentId = loop.documentId;

      await withDb.tx(async (tx) => {
        // Stale-write guard: if the artifact has advanced beyond the version this
        // loop was created for, a newer evaluation loop has already run (or is
        // in flight). Skip ingestion to prevent old scores from overwriting newer ones.
        // Check is inside the transaction to avoid a TOCTOU race between read and write.
        if (loop.documentVersion != null) {
          const artifact = await tx.artifact.findUnique({
            where: documentWhere({ id: documentId, organizationId }),
            select: { document: { select: { latestVersion: true } } },
          });

          const latestVersion = artifact?.document?.latestVersion;
          if (latestVersion != null && latestVersion > loop.documentVersion) {
            log.info(
              `[loop-document-ingestion] Skipping ${label} evaluation ingest — artifact has a newer version`,
              {
                documentId,
                loopId: loop.id,
                loopArtifactVersion: loop.documentVersion,
                currentArtifactVersion: latestVersion,
              }
            );
            return;
          }
        }

        await upsertEvaluationWithJudgeScores({
          artifactId: documentId,
          loopId: loop.id,
          organizationId,
          reportType,
          report,
          tx,
        });
      });
    },
  });
}
