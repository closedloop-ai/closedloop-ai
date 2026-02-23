import type { PlanJson } from "@repo/api/src/types/artifact";
import { log } from "@repo/observability/log";
import { CONTENT_KEYS } from "./keys";
import type { ZipContentExtractor } from "./types";
import { ExtractorOutputType } from "./types";

/** Extract plan content from plan.json (experimental plugin artifact). */
export const planJsonExtractor: ZipContentExtractor<
  string,
  typeof ExtractorOutputType.String
> = {
  key: CONTENT_KEYS.planContent,
  outputType: ExtractorOutputType.String,
  priority: 10,

  matches(entryName: string): boolean {
    return entryName.endsWith("plan.json");
  },

  parse(data: Buffer, entryName: string): string | null {
    try {
      const planJson = JSON.parse(data.toString("utf-8")) as PlanJson;
      log.info(
        `Found plan.json: ${entryName} (${planJson.content.length} chars, ${planJson.pendingTasks.length} pending tasks, ${planJson.openQuestions.length} open questions)`
      );
      return planJson.content;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error(`Failed to parse plan.json: ${message}`);
      return null;
    }
  },
};

/** Extract plan content from implementation-plan.md (legacy fallback). */
export const implementationPlanExtractor: ZipContentExtractor<
  string,
  typeof ExtractorOutputType.String
> = {
  key: CONTENT_KEYS.planContent,
  outputType: ExtractorOutputType.String,
  priority: 5,

  matches(entryName: string): boolean {
    return entryName.endsWith("implementation-plan.md");
  },

  parse(data: Buffer, entryName: string): string | null {
    const content = data.toString("utf-8");
    log.info(
      `Found implementation plan: ${entryName} (${content.length} chars)`
    );
    return content;
  },
};
