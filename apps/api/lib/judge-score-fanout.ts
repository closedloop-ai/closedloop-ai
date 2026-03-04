import type {
  JudgesReport,
  MetricStatistics,
} from "@repo/api/src/types/evaluation";
import type { Prisma, TransactionClient } from "@repo/database";
import { PromptType } from "@repo/database";
import { log } from "@repo/observability/log";
import { normalizeJudgeName } from "./judge-name-utils";

/**
 * Fan out judge scores from a JudgesReport into JudgeScore rows.
 *
 * For each case in report.stats, selects the metric whose normalized name matches
 * case_id (falling back to the first metric) and writes a JudgeScore row linked
 * to the ArtifactEvaluation. promptId is resolved by matching normalized judge
 * names to organization JUDGE prompts in prompt_registry.
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
    const metric = selectMetricByCaseId(caseScore.case_id, caseScore.metrics);

    if (metric === undefined) {
      continue;
    }

    const normalizedCaseId = normalizeJudgeName(caseScore.case_id);
    const promptId = promptLookup.get(normalizedCaseId) ?? null;

    if (promptId === null) {
      log.warn("judge_prompt_id_unmatched", {
        caseId: caseScore.case_id,
        organizationId: params.organizationId,
        event: "prompt_id_unmatched",
      });
    }

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

/**
 * Select the metric whose normalized metric_name matches the normalized case_id.
 * Falls back to the first metric if no name match is found.
 */
function selectMetricByCaseId(
  caseId: string,
  metrics: MetricStatistics[]
): MetricStatistics | undefined {
  if (metrics.length === 0) {
    return undefined;
  }

  const normalizedCaseId = normalizeJudgeName(caseId);
  const matched = metrics.find(
    (m) => normalizeJudgeName(m.metric_name) === normalizedCaseId
  );

  if (matched) {
    return matched;
  }

  log.warn("judge_metric_name_mismatch", {
    caseId,
    availableMetrics: metrics.map((m) => m.metric_name),
  });

  return metrics.at(0);
}

function buildPromptLookup(
  judgePrompts: Array<{ id: string; name: string; version: number }>
): Map<string, string> {
  // Query returns latest version per raw prompt name.
  // If multiple names normalize to the same stem, keep the highest version.
  const versionedLookup = new Map<
    string,
    { id: string; version: number; rawName: string }
  >();
  const collisions = new Map<string, string[]>();

  for (const prompt of judgePrompts) {
    const normalizedName = normalizeJudgeName(prompt.name);
    const existing = versionedLookup.get(normalizedName);

    if (existing !== undefined) {
      // Track collision: multiple raw names map to same normalized key
      if (!collisions.has(normalizedName)) {
        collisions.set(normalizedName, [existing.rawName]);
      }
      collisions.get(normalizedName)?.push(prompt.name);
    }

    if (existing === undefined || prompt.version > existing.version) {
      versionedLookup.set(normalizedName, {
        id: prompt.id,
        version: prompt.version,
        rawName: prompt.name,
      });
    }
  }

  // Log any collisions that were detected
  for (const [normalizedName, rawNames] of collisions) {
    const winner = versionedLookup.get(normalizedName);
    log.warn("judge_prompt_name_collision", {
      normalizedName,
      collidingNames: rawNames,
      selected: winner?.rawName,
    });
  }

  const lookup = new Map<string, string>();
  for (const [normalizedName, prompt] of versionedLookup) {
    lookup.set(normalizedName, prompt.id);
  }

  return lookup;
}
