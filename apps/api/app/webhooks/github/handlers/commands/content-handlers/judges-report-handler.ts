import type { JudgesReport } from "@repo/api/src/types/evaluation";
import { log } from "@repo/observability/log";
import { CONTENT_KEYS } from "../../../extractors/keys";
import type { ContentKey } from "../../../extractors/types";
import type { ContentTransactionHandler } from "./types";

function makeJudgesReportHandler(
  key: ContentKey<JudgesReport>,
  label: string
): ContentTransactionHandler<JudgesReport> {
  return {
    key,
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

      log.info(`[${label}] Persisted judges report`, {
        artifactId: ctx.artifactId,
        reportId: value.report_id,
        judgesCount: value.stats?.length ?? "?",
      });
    },
  };
}

export const judgesReportHandler = makeJudgesReportHandler(
  CONTENT_KEYS.judgesReport,
  "judgesReportHandler"
);

export const codeJudgesReportHandler = makeJudgesReportHandler(
  CONTENT_KEYS.codeJudgesReport,
  "codeJudgesReportHandler"
);
