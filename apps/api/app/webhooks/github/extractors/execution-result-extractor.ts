import type { ExecutionResult } from "@repo/api/src/types/execution-result";
import { log } from "@repo/observability/log";
import { CONTENT_KEYS } from "./keys";
import type { ZipContentExtractor } from "./types";
import { ExtractorOutputType } from "./types";

/** Extract execution result JSON (PR metadata from execute runs). */
export const executionResultExtractor: ZipContentExtractor<
  ExecutionResult,
  typeof ExtractorOutputType.ExecutionResult
> = {
  key: CONTENT_KEYS.executionResult,
  outputType: ExtractorOutputType.ExecutionResult,
  priority: 0,

  matches(entryName: string): boolean {
    return entryName.endsWith("execution-result.json");
  },

  parse(data: Buffer, entryName: string): ExecutionResult | null {
    try {
      const result = JSON.parse(data.toString("utf-8")) as ExecutionResult;
      log.info(`Found execution result: ${entryName}, PR #${result.pr_number}`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error(`Failed to parse execution-result.json: ${message}`);
      return null;
    }
  },
};
