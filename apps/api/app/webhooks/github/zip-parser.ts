import type { PlanJson } from "@repo/api/src/types/artifact";
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { ExecutionResult } from "@repo/api/src/types/execution-result";
import type { PerfSummary } from "@repo/api/src/types/performance";
import { parsePerfSummary } from "@repo/github/perf-parser";
import { log } from "@repo/observability/log";
import type AdmZip from "adm-zip";
import { isPromptFileEntry, parsePromptFile } from "./prompt-parser";
import type { PromptsSnapshot } from "./prompt-types";

export type ZipContent = {
  planContent: string | null;
  questionsContent: string | null;
  executionResult: ExecutionResult | null;
  judgesReport: JudgesReport | null;
  codeJudgesReport: JudgesReport | null;
  perfSummary: PerfSummary | null;
  promptsSnapshot: PromptsSnapshot | null;
  entries: { name: string; data: Buffer }[];
};

/**
 * Parse execution result JSON safely.
 */
function parseExecutionResult(
  content: Buffer,
  entryName: string
): ExecutionResult | null {
  try {
    const jsonContent = content.toString("utf-8");
    const result = JSON.parse(jsonContent) as ExecutionResult;
    log.info(`Found execution result: ${entryName}, PR #${result.pr_number}`);
    return result;
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
 * Parse plan.json from experimental plugin artifacts.
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
 * Search a zip for plan, questions, execution result, judges reports, perf summary,
 * or prompts snapshot files. Returns extracted content if found.
 *
 * Priority for plan content:
 * 1. plan.json (experimental plugin artifact)
 * 2. implementation-plan.md (legacy)
 */
export function findPlanInZip(zip: AdmZip): ZipContent {
  const entries: { name: string; data: Buffer }[] = [];
  let planContent: string | null = null;
  let questionsContent: string | null = null;
  let executionResult: ExecutionResult | null = null;
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
    });
    planContent = contentResult.planContent;
    questionsContent = contentResult.questionsContent;
    executionResult = contentResult.executionResult;
    judgesReport = contentResult.judgesReport;
    codeJudgesReport = contentResult.codeJudgesReport;
    perfSummary = contentResult.perfSummary;

    if (isPromptFileEntry(name)) {
      const prompt = parsePromptFile(data, name);
      if (prompt !== null) {
        if (promptsSnapshot === null) {
          promptsSnapshot = { prompts: [prompt] };
        } else {
          promptsSnapshot.prompts.push(prompt);
        }
      }
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
    entries,
  };
}

type ZipEntryContentArgs = {
  data: Buffer;
  name: string;
  planContent: string | null;
  questionsContent: string | null;
  executionResult: ExecutionResult | null;
  judgesReport: JudgesReport | null;
  codeJudgesReport: JudgesReport | null;
  perfSummary: PerfSummary | null;
};

function parseZipEntryContent(
  args: ZipEntryContentArgs
): Omit<ZipContent, "promptsSnapshot" | "entries"> {
  const {
    data,
    name,
    planContent: currentPlan,
    questionsContent: currentQuestions,
    executionResult: currentExecutionResult,
    judgesReport: currentJudgesReport,
    codeJudgesReport: currentCodeJudgesReport,
    perfSummary: currentPerfSummary,
  } = args;

  let planContent = currentPlan;
  let questionsContent = currentQuestions;
  let executionResult = currentExecutionResult;
  let judgesReport = currentJudgesReport;
  let codeJudgesReport = currentCodeJudgesReport;
  let perfSummary = currentPerfSummary;

  // Priority 1: plan.json from experimental plugin
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

  return {
    planContent,
    questionsContent,
    executionResult,
    judgesReport,
    codeJudgesReport,
    perfSummary,
  };
}
