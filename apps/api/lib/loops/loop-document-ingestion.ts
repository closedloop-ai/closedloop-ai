/**
 * Shared utilities for loop document ingestion.
 *
 * Command-specific download and ingestion logic lives in the handler files:
 * - plan-handler.ts (PLAN / REQUEST_CHANGES)
 * - execute-handler.ts (EXECUTE)
 */

import type {
  EvaluationReportType,
  JudgesReport,
} from "@repo/api/src/types/evaluation";
import type { TransactionClient } from "@repo/database";
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
    log.warn(`[loop-document-ingestion] Failed to parse ${artifactName}`, {
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
  loopId?: string;
  actionRunId?: string;
  organizationId: string;
  reportType: EvaluationReportType;
  report: JudgesReport;
  tx: TransactionClient;
}): Promise<void> {
  const {
    artifactId,
    loopId,
    actionRunId,
    organizationId,
    reportType,
    report,
    tx,
  } = params;

  const evaluation = await tx.artifactEvaluation.upsert({
    where: {
      artifactId_reportId: {
        artifactId,
        reportId: report.report_id,
      },
    },
    create: {
      organizationId,
      artifactId,
      ...(loopId ? { loopId } : {}),
      ...(actionRunId ? { actionRunId } : {}),
      reportType,
      reportId: report.report_id,
      reportData: report,
    },
    update: {
      ...(loopId ? { loopId } : {}),
      ...(actionRunId ? { actionRunId } : {}),
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
