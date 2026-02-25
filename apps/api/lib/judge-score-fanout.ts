import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { Prisma, TransactionClient } from "@repo/database";

/**
 * Fan out judge scores from a JudgesReport into JudgeScore rows.
 *
 * For each case in report.stats, reads the first metric and writes a JudgeScore
 * row linked to the ArtifactEvaluation. promptId is always null until the
 * prompt_registry table exists (PR 1 not yet merged).
 *
 * @param params.evaluationId - The ArtifactEvaluation id to link scores to
 * @param params.organizationId - The org id (reserved for prompt lookup when PR 1 lands)
 * @param params.report - The parsed JudgesReport from judges.json
 * @param params.tx - Active transaction client
 */
export async function fanOutJudgeScores(params: {
  evaluationId: string;
  organizationId: string;
  report: JudgesReport;
  tx: TransactionClient;
}): Promise<void> {
  if (params.report.stats.length === 0) {
    return;
  }

  // TODO: look up prompt ids from prompt_registry when PR 1 is merged.
  // Prompt model does not exist yet — set promptId = null for all rows.
  // When enabled, query:
  //   params.tx.prompt.findMany({ where: { organizationId: params.organizationId, promptType: "JUDGE" }, select: { id: true, name: true } })
  // and build Map<string, string> of normalizeJudgeName(prompt.name) -> prompt.id.

  const rows: Prisma.JudgeScoreCreateManyInput[] = [];

  for (const caseScore of params.report.stats) {
    const metric = caseScore.metrics.at(0);

    if (metric === undefined) {
      continue;
    }

    const promptId: string | null = null;

    rows.push({
      evaluationId: params.evaluationId,
      promptId,
      caseId: caseScore.case_id,
      threshold: metric.threshold,
      score: metric.score,
      justification: metric.justification,
      finalStatus: caseScore.final_status,
    });
  }

  if (rows.length > 0) {
    await params.tx.judgeScore.createMany({ data: rows, skipDuplicates: true });
  }
}
