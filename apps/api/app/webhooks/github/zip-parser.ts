import type { PlanJson } from "@repo/api/src/types/artifact";
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import { log } from "@repo/observability/log";
import type AdmZip from "adm-zip";

export type ExecutionResult = {
  has_changes: boolean;
  pr_url: string;
  pr_number: string | number; // GitHub Actions outputs as string
  pr_title?: string; // Optional - may not be in workflow output
  branch_name: string;
  base_ref?: string; // Workflow uses base_ref, not base_branch
  base_branch?: string; // Legacy/alternative field name
  github_id?: number;
  commit_sha?: string;
};

export type ZipContent = {
  planContent: string | null;
  questionsContent: string | null;
  executionResult: ExecutionResult | null;
  judgesReport: JudgesReport | null;
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
 * Search a zip for plan, questions, execution result, or judges report files.
 * Returns the content if found, null otherwise.
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

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }

    const content = entry.getData();
    const name = entry.entryName;
    entries.push({ name, data: content });

    // Priority 1: plan.json from experimental plugin
    if (name.endsWith("plan.json") && !planContent) {
      planContent = parsePlanJson(content, name);
    }
    // Priority 2: implementation-plan.md (legacy, only if plan.json not found)
    else if (name.endsWith("implementation-plan.md") && !planContent) {
      planContent = content.toString("utf-8");
      log.info(
        `Found implementation plan: ${name} (${planContent.length} chars)`
      );
    }
    // Check for questions files (both old and new names)
    else if (
      name.endsWith("open-questions.md") ||
      name.endsWith("investigation-questions.md")
    ) {
      questionsContent = content.toString("utf-8");
      log.info(
        `Found questions file: ${name} (${questionsContent.length} chars)`
      );
    }
    // Check for execution result
    else if (name.endsWith("execution-result.json")) {
      executionResult = parseExecutionResult(content, name);
    }
    // Check for judges report
    else if (name.endsWith("judges.json")) {
      judgesReport = parseJudgesReport(content, name);
    }
  }

  return {
    planContent,
    questionsContent,
    executionResult,
    judgesReport,
    entries,
  };
}
