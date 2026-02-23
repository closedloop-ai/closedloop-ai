import type { JudgesReport } from "@repo/api/src/types/evaluation";
import { CONTENT_KEYS } from "./keys";
import { parseJudgesReportBuffer } from "./parse-judges-report";
import type { ZipContentExtractor } from "./types";
import { ExtractorOutputType } from "./types";

/** Parse code judges report JSON safely. Exported for direct use in tests. */
export function parseCodeJudgesReport(
  data: Buffer,
  entryName: string
): JudgesReport | null {
  return parseJudgesReportBuffer(data, entryName, "code judges report");
}

/** Extract code judges evaluation report from code-judges.json. */
export const codeJudgesReportExtractor: ZipContentExtractor<
  JudgesReport,
  typeof ExtractorOutputType.JudgesReport
> = {
  key: CONTENT_KEYS.codeJudgesReport,
  outputType: ExtractorOutputType.JudgesReport,
  priority: 0,

  matches(entryName: string): boolean {
    return entryName.endsWith("code-judges.json");
  },

  parse: parseCodeJudgesReport,
};
