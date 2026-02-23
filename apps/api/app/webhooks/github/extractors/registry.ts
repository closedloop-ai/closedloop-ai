import { codeJudgesReportExtractor } from "./code-judges-report-extractor";
import { executionResultExtractor } from "./execution-result-extractor";
import { judgesReportExtractor } from "./judges-report-extractor";
import { perfSummaryExtractor } from "./perf-summary-extractor";
import {
  implementationPlanExtractor,
  planJsonExtractor,
} from "./plan-extractor";
import { promptsExtractor } from "./prompts-extractor";
import { questionsExtractor } from "./questions-extractor";
import type { AnyZipContentExtractor } from "./types";

/**
 * All registered zip content extractors.
 *
 * To add a new content type:
 * 1. Define the type in packages/api/src/types/
 * 2. Add a ContentKey in ./keys.ts
 * 3. Add a member to ExtractorOutputType in ./types.ts
 * 4. Create an extractor file implementing ZipContentExtractor<T, Kind>
 * 5. Add it to this array
 */
export const ZIP_CONTENT_EXTRACTORS: AnyZipContentExtractor[] = [
  planJsonExtractor,
  implementationPlanExtractor,
  questionsExtractor,
  executionResultExtractor,
  judgesReportExtractor,
  codeJudgesReportExtractor,
  perfSummaryExtractor,
  promptsExtractor,
];
