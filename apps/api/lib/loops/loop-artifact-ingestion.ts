/**
 * Shared utilities for loop artifact ingestion.
 *
 * Command-specific download and ingestion logic lives in the handler files:
 * - plan-handler.ts (PLAN / REQUEST_CHANGES)
 * - execute-handler.ts (EXECUTE)
 */

import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type {
  EvaluationReportType as PrismaEvaluationReportType,
  TransactionClient,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { fanOutJudgeScores } from "@/lib/judge-score-fanout";

export function parseJsonArtifact<T>(
  buf: Buffer | null,
  artifactName: string,
  extract: (parsed: T) => unknown
): unknown {
  if (!buf) {
    return null;
  }
  try {
    const parsed = JSON.parse(buf.toString("utf-8")) as T;
    return extract(parsed);
  } catch (err) {
    log.warn(`[loop-artifact-ingestion] Failed to parse ${artifactName}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Upsert an ArtifactEvaluation record and fan out judge scores within a transaction.
 *
 * Encapsulates the repeated pattern across plan-handler and execute-handler of:
 * 1. Upserting an ArtifactEvaluation row (keyed by artifactId + reportId)
 * 2. Fanning out per-judge scores via fanOutJudgeScores
 */
export async function upsertEvaluationWithJudgeScores(params: {
  artifactId: string;
  loopId: string;
  organizationId: string;
  reportType: PrismaEvaluationReportType;
  report: JudgesReport;
  tx: TransactionClient;
}): Promise<void> {
  const { artifactId, loopId, organizationId, reportType, report, tx } = params;

  const evaluation = await tx.artifactEvaluation.upsert({
    where: {
      artifactId_reportId: {
        artifactId,
        reportId: report.report_id,
      },
    },
    create: {
      artifactId,
      loopId,
      reportType,
      reportId: report.report_id,
      reportData: report,
    },
    update: {
      loopId,
      reportType,
      reportData: report,
    },
  });

  await fanOutJudgeScores({
    evaluationId: evaluation.id,
    organizationId,
    report,
    tx,
  });
}
