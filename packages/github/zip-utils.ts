import { log } from "@repo/observability/log";
import AdmZip from "adm-zip";

/**
 * GitHub Actions artifact name prefixes that contain Symphony run data
 * (conversation logs, plans, execution results).
 *
 * - symphony-run-{issue_number}: uploaded by symphony-artifact action
 * - symphony-dispatch-{id}: uploaded by symphony-dispatch workflow
 */
export const SYMPHONY_RUN_ARTIFACT_PREFIXES = [
  "symphony-run-",
  "symphony-dispatch-",
] as const;

/**
 * Extract inner zip files from an outer zip.
 *
 * GitHub artifact downloads are wrapped in an outer zip. Symphony CI may also
 * produce nested zips (e.g. symphony-run.zip) inside. This utility finds and
 * opens all nested .zip entries, returning them as AdmZip instances.
 *
 * Used by both execution-log-parser (to find conversation logs) and
 * workflow-artifacts (to find plan/execution content).
 */
export function extractInnerZips(outerZip: AdmZip): AdmZip[] {
  const innerZips: AdmZip[] = [];

  for (const entry of outerZip.getEntries()) {
    if (!entry.entryName.endsWith(".zip") || entry.isDirectory) {
      continue;
    }

    try {
      innerZips.push(new AdmZip(entry.getData()));
    } catch (error) {
      log.error(
        `[zip-utils] Failed to extract nested zip: ${entry.entryName}`,
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  return innerZips;
}
