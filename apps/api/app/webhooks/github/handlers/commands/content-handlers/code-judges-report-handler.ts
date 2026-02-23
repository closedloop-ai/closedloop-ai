import type { JudgesReport } from "@repo/api/src/types/evaluation";
import { log } from "@repo/observability/log";
import { CONTENT_KEYS } from "../../../extractors/keys";
import type { ContentTransactionHandler } from "./types";

export const codeJudgesReportHandler: ContentTransactionHandler<JudgesReport> =
  {
    key: CONTENT_KEYS.codeJudgesReport,

    async handle(tx, ctx, value): Promise<void> {
      if (!ctx.actionRunId) {
        return;
      }

      await tx.artifactEvaluation.upsert({
        where: {
          artifactId_reportId: {
            artifactId: ctx.artifactId,
            reportId: value.report_id,
          },
        },
        create: {
          artifactId: ctx.artifactId,
          actionRunId: ctx.actionRunId,
          reportId: value.report_id,
          reportData: value,
        },
        update: {
          reportData: value,
        },
      });

      log.info("[codeJudgesReportHandler] Persisted code judges report", {
        artifactId: ctx.artifactId,
        reportId: value.report_id,
        judgesCount: value.stats.length,
      });
    },
  };
