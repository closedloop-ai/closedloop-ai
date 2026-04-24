import {
  detectExecutionResultSchemaVersion,
  type ExecutionResultFile,
  ExecutionResultFileSchema,
  type ExecutionResultV2,
  ExecutionResultV2Schema,
} from "@closedloop-ai/loops-api/execution-result";
import type { PlanJson } from "@repo/api/src/types/document";
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { PerfSummary } from "@repo/api/src/types/performance";
import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import { parsePerfSummary } from "@repo/github/perf-parser";
import { parsePromptsSnapshotFromMarkdownEntries } from "@repo/github/prompt-snapshot-parser";
import { log } from "@repo/observability/log";
import type AdmZip from "adm-zip";

export type ZipContent = {
  planContent: string | null;
  questionsContent: string | null;
  executionResult: ExecutionResultFile | ExecutionResultV2 | null;
  judgesReport: JudgesReport | null;
  codeJudgesReport: JudgesReport | null;
  perfSummary: PerfSummary | null;
  promptsSnapshot: PromptsSnapshot | null;
  entries: { name: string; data: Buffer }[];
};

/**
 * Parse execution result JSON safely using structural Zod validation.
 * Returns the validated raw parsed data so callers can distinguish v1 vs v2.
 * Normalization (fullName-aware) is deferred to the completion handler.
 */
function parseExecutionResult(
  content: Buffer,
  entryName: string
): ExecutionResultFile | ExecutionResultV2 | null {
  try {
    const jsonContent = content.toString("utf-8");
    const parsed: unknown = JSON.parse(jsonContent);

    const schemaVersion = detectExecutionResultSchemaVersion(parsed);

    if (schemaVersion === 2) {
      const result = ExecutionResultV2Schema.safeParse(parsed);
      if (!result.success) {
        log.error(
          `Failed to parse execution-result.json (v2): ${result.error.message}`
        );
        return null;
      }
      log.info(`Found execution-result.json (v2): ${entryName}`);
      return result.data;
    }

    // v1: schemaVersion absent or 1
    const result = ExecutionResultFileSchema.safeParse(parsed);
    if (!result.success) {
      log.error(
        `Failed to parse execution-result.json (v1): ${result.error.message}`
      );
      return null;
    }
    log.info(`Found execution-result.json: ${entryName}`);
    return result.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error(`Failed to parse execution-result.json: ${message}`);
    return null;
  }
}

/**
 * Parse judges report JSON safely.
 */
export function parseJudgesReport(
  content: Buffer,
  entryName: string
): JudgesReport | null {
  try {
    const jsonContent = content.toString("utf-8");
    const result = JSON.parse(jsonContent) as JudgesReport;
    log.info(
      `Found judges report: ${entryName}, report_id: ${result.report_id}, ${result.stats.length} judges`
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error(`Failed to parse judges.json: ${message}`);
    return null;
  }
}

/**
 * Parse plan.json from code plugin artifacts.
 * Returns the markdown content from the JSON structure, or null if parsing fails.
 */
function parsePlanJson(content: Buffer, entryName: string): string | null {
  try {
    const jsonContent = content.toString("utf-8");
    const planJson = JSON.parse(jsonContent) as PlanJson;
    log.info(
      `Found plan.json: ${entryName} (${planJson.content.length} chars, ${planJson.pendingTasks.length} pending tasks, ${planJson.openQuestions.length} open questions)`
    );
    return planJson.content;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error(`Failed to parse plan.json: ${message}`);
    return null;
  }
}

/**
 * Search a zip for plan, questions, execution result, or judges report files.
 * Returns the content if found, null otherwise.
 *
 * Priority for plan content:
 * 1. plan.json (code plugin artifact)
 * 2. implementation-plan.md (legacy)
 */
export function findPlanInZip(zip: AdmZip): ZipContent {
  const entries: { name: string; data: Buffer }[] = [];
  let planContent: string | null = null;
  let questionsContent: string | null = null;
  let executionResult: ExecutionResultFile | ExecutionResultV2 | null = null;
  let judgesReport: JudgesReport | null = null;
  let codeJudgesReport: JudgesReport | null = null;
  let perfSummary: PerfSummary | null = null;
  let promptsSnapshot: PromptsSnapshot | null = null;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }

    const data = entry.getData();
    const name = entry.entryName;
    entries.push({ name, data });

    const contentResult = parseZipEntryContent({
      data,
      name,
      planContent,
      questionsContent,
      executionResult,
      judgesReport,
      codeJudgesReport,
      perfSummary,
      promptsSnapshot,
    });
    planContent = contentResult.planContent;
    questionsContent = contentResult.questionsContent;
    executionResult = contentResult.executionResult;
    judgesReport = contentResult.judgesReport;
    codeJudgesReport = contentResult.codeJudgesReport;
    perfSummary = contentResult.perfSummary;
    promptsSnapshot = contentResult.promptsSnapshot;
  }

  return {
    planContent,
    questionsContent,
    executionResult,
    judgesReport,
    codeJudgesReport,
    perfSummary,
    promptsSnapshot,
    entries,
  };
}

type ZipEntryContentArgs = {
  data: Buffer;
  name: string;
  planContent: string | null;
  questionsContent: string | null;
  executionResult: ExecutionResultFile | ExecutionResultV2 | null;
  judgesReport: JudgesReport | null;
  codeJudgesReport: JudgesReport | null;
  perfSummary: PerfSummary | null;
  promptsSnapshot: PromptsSnapshot | null;
};

function parseZipEntryContent(
  args: ZipEntryContentArgs
): Omit<ZipContent, "entries"> {
  const {
    data,
    name,
    planContent: currentPlan,
    questionsContent: currentQuestions,
    executionResult: currentExecutionResult,
    judgesReport: currentJudgesReport,
    codeJudgesReport: currentCodeJudgesReport,
    perfSummary: currentPerfSummary,
    promptsSnapshot: currentPromptsSnapshot,
  } = args;

  let planContent = currentPlan;
  let questionsContent = currentQuestions;
  let executionResult = currentExecutionResult;
  let judgesReport = currentJudgesReport;
  let codeJudgesReport = currentCodeJudgesReport;
  let perfSummary = currentPerfSummary;
  let promptsSnapshot = currentPromptsSnapshot;

  // Priority 1: plan.json from code plugin
  if (name.endsWith("plan.json") && !planContent) {
    planContent = parsePlanJson(data, name);
  }
  // Priority 2: implementation-plan.md (legacy, only if plan.json not found)
  else if (name.endsWith("implementation-plan.md") && !planContent) {
    planContent = data.toString("utf-8");
    log.info(
      `Found implementation plan: ${name} (${planContent.length} chars)`
    );
  }
  // Check for questions files (both old and new names)
  else if (
    name.endsWith("open-questions.md") ||
    name.endsWith("investigation-questions.md")
  ) {
    questionsContent = data.toString("utf-8");
    log.info(
      `Found questions file: ${name} (${questionsContent.length} chars)`
    );
  }
  // Check for execution result
  else if (name.endsWith("execution-result.json")) {
    executionResult = parseExecutionResult(data, name);
  }
  // Check for code judges report (must come before generic judges.json)
  else if (name.endsWith("code-judges.json")) {
    codeJudgesReport = parseJudgesReport(data, name);
  }
  // Check for judges report
  else if (name.endsWith("judges.json")) {
    judgesReport = parseJudgesReport(data, name);
  }
  // Check for perf summary
  else if (name.endsWith("perf.jsonl")) {
    perfSummary = parsePerfSummary(data);
    log.info(`Found perf.jsonl: ${name}`);
  }
  // Check for agents-snapshot markdown files
  else {
    const parsedSnapshot = parsePromptsSnapshotFromMarkdownEntries(
      [{ name, data }],
      "[zip-parser]"
    );
    if (parsedSnapshot) {
      promptsSnapshot = {
        prompts: [
          ...(promptsSnapshot?.prompts ?? []),
          ...parsedSnapshot.prompts,
        ],
      };
    }
  }

  return {
    planContent,
    questionsContent,
    executionResult,
    judgesReport,
    codeJudgesReport,
    perfSummary,
    promptsSnapshot,
  };
}
