import { EvalStatus, type JudgesReport } from "@repo/api/src/types/evaluation";
import type { Prisma, TransactionClient } from "@repo/database";
import { PromptType } from "@repo/database";
import { log } from "@repo/observability/log";
import { normalizeJudgeName } from "./judge-name-utils";

/**
 * Fan out judge scores from a JudgesReport into JudgeScore rows.
 *
 * For each case in report.stats, creates one JudgeScore row per metric in the
 * case's metrics array. promptId is resolved by matching normalized case_id to
 * organization JUDGE prompts.
 *
 * @param params.evaluationId - The ArtifactEvaluation id to link scores to
 * @param params.organizationId - The org id used for prompt lookup
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
    if (caseScore.metrics.length === 0) {
      continue;
    }

    const finalStatus = normalizeFinalStatus(caseScore.final_status as unknown);
    if (finalStatus === null) {
      log.warn("judge_final_status_invalid", {
        caseId: caseScore.case_id,
        rawFinalStatus: caseScore.final_status,
      });
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

    for (const metric of caseScore.metrics) {
      rows.push({
        evaluationId: params.evaluationId,
        promptId,
        caseId: caseScore.case_id,
        metricName: normalizeJudgeName(metric.metric_name),
        threshold: metric.threshold,
        score: metric.score,
        justification: metric.justification,
        finalStatus,
      });
    }
  }

  if (rows.length > 0) {
    await params.tx.judgeScore.createMany({ data: rows, skipDuplicates: true });
  }
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

const STATUS_FROM_NUMERIC: Record<number, EvalStatus> = {
  // Legacy harness encoding used in some judges reports.
  1: EvalStatus.Passed,
  2: EvalStatus.NeedsImprovement,
  3: EvalStatus.Failed,
};

const STATUS_FROM_SYMBOLIC_KEY: Record<string, EvalStatus> = {
  Failed: EvalStatus.Failed,
  NeedsImprovement: EvalStatus.NeedsImprovement,
  Passed: EvalStatus.Passed,
};

const EVAL_STATUS_VALUES = new Set<EvalStatus>(Object.values(EvalStatus));

function normalizeFinalStatus(rawFinalStatus: unknown): EvalStatus | null {
  if (typeof rawFinalStatus === "number") {
    return STATUS_FROM_NUMERIC[rawFinalStatus] ?? null;
  }

  if (typeof rawFinalStatus !== "string") {
    return null;
  }

  const trimmedStatus = rawFinalStatus.trim();
  if (trimmedStatus.length === 0) {
    return null;
  }

  const numericStatus = Number(trimmedStatus);
  if (Number.isInteger(numericStatus)) {
    return STATUS_FROM_NUMERIC[numericStatus] ?? null;
  }

  if (EVAL_STATUS_VALUES.has(trimmedStatus as EvalStatus)) {
    return trimmedStatus as EvalStatus;
  }

  return STATUS_FROM_SYMBOLIC_KEY[trimmedStatus] ?? null;
}
