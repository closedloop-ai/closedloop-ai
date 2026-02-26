import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { Prisma, TransactionClient } from "@repo/database";
import { PromptType } from "@repo/database";
import { normalizeJudgeName } from "./judge-name-utils";

/**
 * Fan out judge scores from a JudgesReport into JudgeScore rows.
 *
 * For each case in report.stats, reads the first metric and writes a JudgeScore
 * row linked to the ArtifactEvaluation. promptId is resolved by matching
 * normalized judge names to organization JUDGE prompts in prompt_registry.
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

  const judgePrompts = await params.tx.prompt.findMany({
    where: {
      organizationId: params.organizationId,
      promptType: PromptType.JUDGE,
    },
    distinct: ["name"],
    orderBy: [{ version: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      version: true,
    },
  });

  const promptLookup = buildPromptLookup(judgePrompts);

  const rows: Prisma.JudgeScoreCreateManyInput[] = [];

  for (const caseScore of params.report.stats) {
    const metric = caseScore.metrics.at(0);

    if (metric === undefined) {
      continue;
    }

    const promptId =
      promptLookup.get(normalizeJudgeName(caseScore.case_id)) ?? null;

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

function buildPromptLookup(
  judgePrompts: Array<{ id: string; name: string; version: number }>
): Map<string, string> {
  // Query already returns the latest version per prompt name.
  // Keep the first prompt we see per normalized stem.
  const lookup = new Map<string, string>();

  for (const prompt of judgePrompts) {
    const normalizedName = normalizeJudgeName(prompt.name);

    if (!lookup.has(normalizedName)) {
      lookup.set(normalizedName, prompt.id);
    }
  }

  return lookup;
}
