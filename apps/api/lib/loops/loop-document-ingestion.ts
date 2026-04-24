/**
 * Shared utilities for loop document ingestion.
 *
 * Command-specific download and ingestion logic lives in the handler files:
 * - plan-handler.ts (PLAN / REQUEST_CHANGES)
 * - execute-handler.ts (EXECUTE)
 */

import type { EntityType } from "@repo/api/src/types/entity-link";
import type {
  EvaluationReportType,
  JudgesReport,
} from "@repo/api/src/types/evaluation";
import type { TransactionClient } from "@repo/database";
import { log } from "@repo/observability/log";
import { assertEntityInOrganization } from "@/lib/entity-validation";
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
 * Upsert a DocumentEvaluation record and fan out judge scores within a transaction.
 *
 * Encapsulates the repeated pattern across plan-handler and execute-handler of:
 * 1. Upserting a DocumentEvaluation row (keyed by documentId + reportId)
 * 2. Fanning out per-judge scores via fanOutJudgeScores
 */
export async function upsertEvaluationWithJudgeScores(params: {
  entityId: string;
  entityType: EntityType;
  documentId?: string | null;
  loopId: string;
  actionRunId?: string;
  organizationId: string;
  reportType: EvaluationReportType;
  report: JudgesReport;
  tx: TransactionClient;
}): Promise<void> {
  const {
    entityId,
    entityType,
    documentId,
    loopId,
    actionRunId,
    organizationId,
    reportType,
    report,
    tx,
  } = params;

  await assertEntityInOrganization(organizationId, entityId, entityType);

  const evaluation = await tx.documentEvaluation.upsert({
    where: {
      entityId_reportId: {
        entityId,
        reportId: report.report_id,
      },
    },
    create: {
      organizationId,
      entityId,
      entityType,
      documentId: documentId ?? null,
      loopId,
      ...(actionRunId ? { actionRunId } : {}),
      reportType,
      reportId: report.report_id,
      reportData: report,
    },
    update: {
      loopId,
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
