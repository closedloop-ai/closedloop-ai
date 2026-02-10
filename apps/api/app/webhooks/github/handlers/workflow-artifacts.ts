import type { JudgesReport } from "@repo/api/src/types/evaluation";
import { uploadArtifact } from "@repo/aws";
import { downloadWorkflowArtifacts } from "@repo/github";
import { log } from "@repo/observability/log";
import AdmZip from "adm-zip";
import {
  type ExecutionResult,
  findPlanInZip,
  type ZipContent,
} from "../zip-parser";

/**
 * Result type returned by processArtifactUploads.
 */
export type ProcessArtifactResult = {
  planContent: string | null;
  questionsContent: string | null;
  executionResult: ExecutionResult | null;
  judgesReport: JudgesReport | null;
  artifactKeys: string[];
};

/**
 * Upload entries to S3, optionally filtering out certain file types.
 *
 * Pure async function - no side effects beyond S3 upload.
 */
export async function uploadEntriesToS3(
  correlationId: string,
  entries: { name: string; data: Buffer }[],
  skipZips = false
): Promise<string[]> {
  const artifactKeys: string[] = [];
  for (const entry of entries) {
    if (skipZips && entry.name.endsWith(".zip")) {
      continue;
    }
    const s3Key = `plans/${correlationId}/${entry.name}`;
    await uploadArtifact(s3Key, entry.data);
    artifactKeys.push(s3Key);
  }
  return artifactKeys;
}

/**
 * Merge zip content results, preferring non-null values from new result.
 *
 * Pure function - no side effects, testable.
 */
export function mergeZipContent(
  current: Omit<ZipContent, "entries">,
  result: ZipContent
): Omit<ZipContent, "entries"> {
  return {
    planContent: result.planContent ?? current.planContent,
    questionsContent: result.questionsContent ?? current.questionsContent,
    executionResult: result.executionResult ?? current.executionResult,
    judgesReport: result.judgesReport ?? current.judgesReport,
  };
}

/**
 * Process a single artifact zip, handling nested zips.
 *
 * Pure parsing function (extracts and merges content) combined with optional S3 upload.
 * Handles both:
 * - Nested zips (GitHub wraps artifacts, Symphony may also zip)
 * - Direct zip content (fallback)
 */
export async function processArtifactZip(
  correlationId: string,
  artifactData: Buffer,
  artifactName: string,
  uploadToS3: boolean
): Promise<ZipContent & { artifactKeys: string[] }> {
  const outerZip = new AdmZip(artifactData);
  const outerEntries = outerZip.getEntries();
  const artifactKeys: string[] = [];

  log.info(
    `[processArtifactZip] "${artifactName}" contains ${outerEntries.length} files`
  );

  let content: Omit<ZipContent, "entries"> = {
    planContent: null,
    questionsContent: null,
    executionResult: null,
    judgesReport: null,
  };

  // Check for nested zips first (Symphony artifact structure)
  for (const entry of outerEntries) {
    const isNestedZip = entry.entryName.endsWith(".zip") && !entry.isDirectory;
    if (!isNestedZip) {
      continue;
    }

    log.info(`[processArtifactZip] Found nested zip: ${entry.entryName}`);
    const innerZip = new AdmZip(entry.getData());
    const result = findPlanInZip(innerZip);
    content = mergeZipContent(content, result);

    if (uploadToS3) {
      const keys = await uploadEntriesToS3(correlationId, result.entries);
      artifactKeys.push(...keys);
    }
  }

  // Also check outer zip directly (in case it's not nested)
  const needsDirectCheck = !(content.planContent || content.executionResult);
  if (needsDirectCheck) {
    const result = findPlanInZip(outerZip);
    content = mergeZipContent(content, result);

    if (uploadToS3) {
      const keys = await uploadEntriesToS3(correlationId, result.entries, true);
      artifactKeys.push(...keys);
    }
  }

  return { ...content, entries: [], artifactKeys };
}

/**
 * Download and extract workflow artifacts, optionally upload to S3.
 * Handles nested zips (GitHub wraps artifacts, Symphony may also zip).
 *
 * Orchestrates:
 * 1. Download from GitHub
 * 2. Parse zips via processArtifactZip
 * 3. Merge results across multiple artifacts
 */
export async function processArtifactUploads(
  correlationId: string,
  runId: number,
  uploadToS3: boolean
): Promise<ProcessArtifactResult> {
  log.info(
    `[processArtifactUploads] Downloading artifacts for run ${runId}, uploadToS3=${uploadToS3}`
  );

  const artifacts = await downloadWorkflowArtifacts(runId);
  let planContent: string | null = null;
  let questionsContent: string | null = null;
  let executionResult: ExecutionResult | null = null;
  let judgesReport: JudgesReport | null = null;
  const artifactKeys: string[] = [];

  log.info(`[processArtifactUploads] Downloaded ${artifacts.length} artifacts`);

  for (const artifact of artifacts) {
    const result = await processArtifactZip(
      correlationId,
      artifact.data,
      artifact.name,
      uploadToS3
    );

    planContent = result.planContent ?? planContent;
    questionsContent = result.questionsContent ?? questionsContent;
    executionResult = result.executionResult ?? executionResult;
    judgesReport = result.judgesReport ?? judgesReport;
    artifactKeys.push(...result.artifactKeys);
  }

  if (planContent || questionsContent || executionResult || judgesReport) {
    log.info(
      `[processArtifactUploads] Found content: plan=${!!planContent}, questions=${!!questionsContent}, execution=${!!executionResult}, judges=${!!judgesReport}`
    );
  } else {
    log.warn(
      "[processArtifactUploads] No plan, questions, execution result, or judges report found in artifacts"
    );
  }

  return {
    planContent,
    questionsContent,
    executionResult,
    judgesReport,
    artifactKeys,
  };
}
