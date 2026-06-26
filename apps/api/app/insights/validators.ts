import {
  INSIGHTS_PERIOD_OPTIONS,
  INSIGHTS_SCOPE_OPTIONS,
  InsightsPeriod,
  InsightsScope,
} from "@repo/api/src/types/insights";
import { z } from "zod";

export const insightsQueryValidator = z.object({
  period: z.enum(INSIGHTS_PERIOD_OPTIONS).default(InsightsPeriod.Quarter),
  scope: z.enum(INSIGHTS_SCOPE_OPTIONS).default(InsightsScope.Me),
});

export type InsightsQuery = z.infer<typeof insightsQueryValidator>;
