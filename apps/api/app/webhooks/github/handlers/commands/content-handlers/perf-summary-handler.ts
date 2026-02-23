import type { PerfSummary } from "@repo/api/src/types/performance";
import type { Prisma } from "@repo/database";
import { log } from "@repo/observability/log";
import { CONTENT_KEYS } from "../../../extractors/keys";
import type { ContentTransactionHandler } from "./types";

export const perfSummaryHandler: ContentTransactionHandler<PerfSummary> = {
  key: CONTENT_KEYS.perfSummary,

  async handle(tx, ctx, value): Promise<void> {
    if (!ctx.actionRunId) {
      return;
    }

    await tx.gitHubActionRunPerformance.upsert({
      where: {
        artifactId_actionRunId: {
          artifactId: ctx.artifactId,
          actionRunId: ctx.actionRunId,
        },
      },
      create: {
        artifactId: ctx.artifactId,
        actionRunId: ctx.actionRunId,
        summaryData: value as unknown as Prisma.InputJsonValue,
      },
      update: {
        summaryData: value as unknown as Prisma.InputJsonValue,
      },
    });

    log.info("[perfSummaryHandler] Persisted perf summary", {
      artifactId: ctx.artifactId,
    });
  },
};
