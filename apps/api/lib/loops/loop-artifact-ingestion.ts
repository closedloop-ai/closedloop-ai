/**
 * Shared utilities for loop artifact ingestion.
 *
 * Command-specific download and ingestion logic lives in the handler files:
 * - plan-handler.ts (PLAN / REQUEST_CHANGES)
 * - execute-handler.ts (EXECUTE)
 */

import { log } from "@repo/observability/log";

export function parseJsonArtifact<T>(
  buf: Buffer | null,
  artifactName: string,
  extract: (parsed: T) => unknown
): unknown {
  if (!buf) {
    return null;
  }
  try {
    const parsed = JSON.parse(buf.toString("utf-8")) as T;
    return extract(parsed);
  } catch (err) {
    log.warn(`[loop-artifact-ingestion] Failed to parse ${artifactName}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
