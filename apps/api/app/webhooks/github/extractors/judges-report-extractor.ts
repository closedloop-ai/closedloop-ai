import type { JudgesReport } from "@repo/api/src/types/evaluation";
import { CONTENT_KEYS } from "./keys";
import { parseJudgesReportBuffer } from "./parse-judges-report";
import type { ZipContentExtractor } from "./types";
import { ExtractorOutputType } from "./types";

/** Parse judges report JSON safely. Exported for direct use in tests. */
export function parseJudgesReport(
  data: Buffer,
  entryName: string
): JudgesReport | null {
  return parseJudgesReportBuffer(data, entryName, "judges report");
}

/** Extract judges evaluation report from judges.json. */
export const judgesReportExtractor: ZipContentExtractor<
  JudgesReport,
  typeof ExtractorOutputType.JudgesReport
> = {
  key: CONTENT_KEYS.judgesReport,
  outputType: ExtractorOutputType.JudgesReport,
  priority: 0,

  matches(entryName: string): boolean {
    return (
      entryName.endsWith("judges.json") &&
      !entryName.endsWith("code-judges.json")
    );
  },

  parse: parseJudgesReport,
};
