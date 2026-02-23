import type { PerfSummary } from "@repo/api/src/types/performance";
import { parsePerfSummary } from "@repo/github/perf-parser";
import { log } from "@repo/observability/log";
import { CONTENT_KEYS } from "./keys";
import type { ZipContentExtractor } from "./types";
import { ExtractorOutputType } from "./types";

/** Extract performance summary from perf.jsonl. */
export const perfSummaryExtractor: ZipContentExtractor<
  PerfSummary,
  typeof ExtractorOutputType.PerfSummary
> = {
  key: CONTENT_KEYS.perfSummary,
  outputType: ExtractorOutputType.PerfSummary,
  priority: 0,

  matches(entryName: string): boolean {
    return entryName.endsWith("perf.jsonl");
  },

  parse(data: Buffer, entryName: string): PerfSummary | null {
    const result = parsePerfSummary(data);
    if (result) {
      log.info(`Found perf.jsonl: ${entryName}`);
    }
    return result;
  },
};
