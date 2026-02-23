import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { PerfSummary } from "@repo/api/src/types/performance";
import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import type { ExecutionResult } from "../zip-parser";
import { contentKey } from "./types";

/** Typed keys for all known content slots in zip artifacts. */
export const CONTENT_KEYS = {
  planContent: contentKey<string>("planContent"),
  questionsContent: contentKey<string>("questionsContent"),
  executionResult: contentKey<ExecutionResult>("executionResult"),
  judgesReport: contentKey<JudgesReport>("judgesReport"),
  codeJudgesReport: contentKey<JudgesReport>("codeJudgesReport"),
  perfSummary: contentKey<PerfSummary>("perfSummary"),
  promptsSnapshot: contentKey<PromptsSnapshot>("promptsSnapshot"),
} as const;
