import type { JudgesReport } from "@repo/api/src/types/evaluation";
import { log } from "@repo/observability/log";
import { CONTENT_KEYS } from "./keys";
import type { ZipContentExtractor } from "./types";
import { ExtractorOutputType } from "./types";

/** Parse code judges report JSON safely. Exported for direct use in tests. */
export function parseCodeJudgesReport(
  data: Buffer,
  entryName: string
): JudgesReport | null {
  try {
    const result = JSON.parse(data.toString("utf-8")) as JudgesReport;
    log.info(
      `Found code judges report: ${entryName}, report_id: ${result.report_id}, ${result.stats.length} judges`
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error(`Failed to parse code-judges.json: ${message}`);
    return null;
  }
}

/** Extract code judges evaluation report from code-judges.json. */
export const codeJudgesReportExtractor: ZipContentExtractor<
  JudgesReport,
  ExtractorOutputType.JudgesReport
> = {
  key: CONTENT_KEYS.codeJudgesReport,
  outputType: ExtractorOutputType.JudgesReport,
  priority: 0,

  matches(entryName: string): boolean {
    return entryName.endsWith("code-judges.json");
  },

  parse: parseCodeJudgesReport,
};
