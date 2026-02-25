import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { PerfSummary } from "@repo/api/src/types/performance";
import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import { downloadWorkflowArtifacts } from "@repo/github";
import { extractInnerZips } from "@repo/github/zip-utils";
import { log } from "@repo/observability/log";
import AdmZip from "adm-zip";
import type { ExecutionResult } from "../types";
import { findPlanInZip, type ZipContent } from "../zip-parser";

/**
 * Result type returned by processArtifactDownloads.
 */
export type ProcessArtifactResult = {
  planContent: string | null;
  questionsContent: string | null;
  executionResult: ExecutionResult | null;
  judgesReport: JudgesReport | null;
  codeJudgesReport: JudgesReport | null;
  perfSummary: PerfSummary | null;
  promptsSnapshot: PromptsSnapshot | null;
};

/**
 * Merge zip content results, preferring non-null values from new result.
 *
 * Pure function - no side effects, testable.
 */
export function mergeZipContent(
  current: Omit<ZipContent, "entries">,
  result: Omit<ZipContent, "entries">
): Omit<ZipContent, "entries"> {
  let promptsSnapshot: PromptsSnapshot | null;
  if (current.promptsSnapshot && result.promptsSnapshot) {
    promptsSnapshot = {
      prompts: [
        ...current.promptsSnapshot.prompts,
        ...result.promptsSnapshot.prompts,
      ],
    };
  } else {
    promptsSnapshot = result.promptsSnapshot ?? current.promptsSnapshot;
  }

  return {
    planContent: result.planContent ?? current.planContent,
    questionsContent: result.questionsContent ?? current.questionsContent,
    executionResult: result.executionResult ?? current.executionResult,
    judgesReport: result.judgesReport ?? current.judgesReport,
    codeJudgesReport: result.codeJudgesReport ?? current.codeJudgesReport,
    perfSummary: result.perfSummary ?? current.perfSummary,
    promptsSnapshot,
  };
}

/**
 * Process a single artifact zip, handling nested zips.
 *
 * Pure parsing function that extracts and merges content.
 * Handles both:
 * - Nested zips (GitHub wraps artifacts, Symphony may also zip)
 * - Direct zip content (fallback)
 */
export function processArtifactZip(
  artifactData: Buffer,
  artifactName: string
): Omit<ZipContent, "entries"> {
  const outerZip = new AdmZip(artifactData);

  log.info(
    `[processArtifactZip] "${artifactName}" contains ${outerZip.getEntries().length} files`
  );

  let content: Omit<ZipContent, "entries"> = {
    planContent: null,
    questionsContent: null,
    executionResult: null,
    judgesReport: null,
    codeJudgesReport: null,
    perfSummary: null,
    promptsSnapshot: null,
  };

  // Check for nested zips first (Symphony artifact structure)
  const innerZips = extractInnerZips(outerZip);
  for (const innerZip of innerZips) {
    const result = findPlanInZip(innerZip);
    content = mergeZipContent(content, result);
  }

  // Also check outer zip directly (in case it's not nested)
  const needsDirectCheck = !(content.planContent || content.executionResult);
  if (needsDirectCheck) {
    const result = findPlanInZip(outerZip);
    content = mergeZipContent(content, result);
  }

  return content;
}

/**
 * Download and extract workflow artifacts.
 * Handles nested zips (GitHub wraps artifacts, Symphony may also zip).
 *
 * Orchestrates:
 * 1. Download from GitHub
 * 2. Parse zips via processArtifactZip
 * 3. Merge results across multiple artifacts
 */
export async function processArtifactDownloads(
  runId: number
): Promise<ProcessArtifactResult> {
  log.info(`[processArtifactDownloads] Downloading artifacts for run ${runId}`);

  const artifacts = await downloadWorkflowArtifacts(runId);
  let content: Omit<ZipContent, "entries"> = {
    planContent: null,
    questionsContent: null,
    executionResult: null,
    judgesReport: null,
    codeJudgesReport: null,
    perfSummary: null,
    promptsSnapshot: null,
  };

  log.info(
    `[processArtifactDownloads] Downloaded ${artifacts.length} artifacts`
  );

  for (const artifact of artifacts) {
    const result = processArtifactZip(artifact.data, artifact.name);
    content = mergeZipContent(content, result);
  }

  const {
    planContent,
    questionsContent,
    executionResult,
    judgesReport,
    codeJudgesReport,
    perfSummary,
    promptsSnapshot,
  } = content;

  if (
    planContent ||
    questionsContent ||
    executionResult ||
    judgesReport ||
    codeJudgesReport
  ) {
    log.info(
      `[processArtifactDownloads] Found content: plan=${!!planContent}, questions=${!!questionsContent}, execution=${!!executionResult}, judges=${!!judgesReport}, codeJudges=${!!codeJudgesReport}`
    );
  } else {
    log.warn(
      "[processArtifactDownloads] No plan, questions, execution result, or judges reports found in artifacts"
    );
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
