import type { JsonObject } from "@repo/api/src/types/common";
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { Loop } from "@repo/api/src/types/loop";
import {
  EvaluationReportType as PrismaEvaluationReportType,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import {
  parseJsonArtifact,
  upsertEvaluationWithJudgeScores,
} from "@/lib/loops/loop-artifact-ingestion";
import { downloadArtifactFile } from "@/lib/loops/loop-state";
import { judgesReportSchema } from "../judges-report-schema";
import { defineHandler } from "./loop-command-handler";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PrdJudgesArtifacts = {
  report: JudgesReport | null;
};

// ---------------------------------------------------------------------------
// Upload-based loading (desktop path)
// ---------------------------------------------------------------------------

function prdJudgesArtifactsFromUpload(
  uploaded: JsonObject
): PrdJudgesArtifacts {
  const report =
    (judgesReportSchema
      .optional()
      .parse(uploaded?.prdJudges ?? undefined) as JudgesReport) ?? null;
  return { report };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const evaluatePrdHandler = defineHandler<PrdJudgesArtifacts>({
  requiresRepo: false,
  requiresParent: false,
  includePrimaryArtifact: true,

  async downloadArtifacts(stateKeyPrefix: string) {
    const buf = await downloadArtifactFile(stateKeyPrefix, "prd-judges.json");
    const report = parseJsonArtifact<JudgesReport>(
      buf,
      "prd-judges.json"
    ) as JudgesReport | null;
    return { report };
  },

  downloadFromUpload: prdJudgesArtifactsFromUpload,

  async ingest(
    loop: Loop,
    organizationId: string,
    artifacts: PrdJudgesArtifacts
  ) {
    if (!loop.artifactId) {
      log.warn(
        "[loop-artifact-ingestion] No artifactId on loop, skipping PRD evaluation ingestion",
        {
          loopId: loop.id,
        }
      );
      return;
    }

    const { report } = artifacts;

    if (!report) {
      log.info("[loop-artifact-ingestion] No PRD judges report to ingest", {
        artifactId: loop.artifactId,
      });
      return;
    }

    const artifactId = loop.artifactId;

    await withDb.tx(async (tx) => {
      await upsertEvaluationWithJudgeScores({
        artifactId,
        loopId: loop.id,
        organizationId,
        reportType: PrismaEvaluationReportType.PRD,
        report,
        tx,
      });
    });
  },
});
