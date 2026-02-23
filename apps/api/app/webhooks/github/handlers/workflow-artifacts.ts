import { uploadArtifact } from "@repo/aws";
import { downloadWorkflowArtifacts } from "@repo/github";
import { extractInnerZips } from "@repo/github/zip-utils";
import { log } from "@repo/observability/log";
import AdmZip from "adm-zip";
import { CONTENT_KEYS } from "../extractors/keys";
import { ZipContentBag } from "../extractors/types";
import { findContentInZip } from "../zip-parser";

export type ProcessArtifactUploadsResult = {
  bag: ZipContentBag;
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
 * Process a single artifact zip, handling nested zips.
 *
 * Handles both:
 * - Nested zips (GitHub wraps artifacts, Symphony may also zip)
 * - Direct zip content (fallback)
 */
export async function processArtifactZip(
  correlationId: string,
  artifactData: Buffer,
  artifactName: string,
  uploadToS3: boolean
): Promise<ProcessArtifactUploadsResult> {
  const outerZip = new AdmZip(artifactData);
  const artifactKeys: string[] = [];

  log.info(
    `[processArtifactZip] "${artifactName}" contains ${outerZip.getEntries().length} files`
  );

  const bag = new ZipContentBag();

  // Check for nested zips first (Symphony artifact structure)
  const innerZips = extractInnerZips(outerZip);
  for (const innerZip of innerZips) {
    const result = findContentInZip(innerZip);
    bag.mergeFrom(result.bag);

    if (uploadToS3) {
      const keys = await uploadEntriesToS3(correlationId, result.entries);
      artifactKeys.push(...keys);
    }
  }

  // Also check outer zip directly (in case it's not nested)
  const needsDirectCheck = !(
    bag.has(CONTENT_KEYS.planContent) || bag.has(CONTENT_KEYS.executionResult)
  );
  if (needsDirectCheck) {
    const result = findContentInZip(outerZip);
    bag.mergeFrom(result.bag);

    if (uploadToS3) {
      const keys = await uploadEntriesToS3(correlationId, result.entries, true);
      artifactKeys.push(...keys);
    }
  }

  return { bag, artifactKeys };
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
): Promise<ProcessArtifactUploadsResult> {
  log.info(
    `[processArtifactUploads] Downloading artifacts for run ${runId}, uploadToS3=${uploadToS3}`
  );

  const artifacts = await downloadWorkflowArtifacts(runId);
  const bag = new ZipContentBag();
  const artifactKeys: string[] = [];

  log.info(`[processArtifactUploads] Downloaded ${artifacts.length} artifacts`);

  for (const artifact of artifacts) {
    const result = await processArtifactZip(
      correlationId,
      artifact.data,
      artifact.name,
      uploadToS3
    );

    bag.mergeFrom(result.bag);
    artifactKeys.push(...result.artifactKeys);
  }

  if (bag.keys().length > 0) {
    log.info(
      `[processArtifactUploads] Found content keys: ${bag.keys().join(", ")}`
    );
  } else {
    log.warn("[processArtifactUploads] No content found in artifacts");
  }

  return { bag, artifactKeys };
}
