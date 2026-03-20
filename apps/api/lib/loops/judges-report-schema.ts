import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared Zod schemas for judges report validation
// Used by plan-handler.ts (judges.json) and execute-handler.ts (code-judges.json)
// ---------------------------------------------------------------------------

export const metricStatisticsSchema = z.object({
  metric_name: z.string(),
  threshold: z.number(),
  score: z.number(),
  justification: z.string(),
});

export const judgesReportSchema = z.object({
  report_id: z.string(),
  timestamp: z.string(),
  stats: z.array(
    z.object({
      type: z.literal("case_score"),
      case_id: z.string(),
      // Accept strings and legacy numeric encodings (1/2/3) —
      // normalizeFinalStatus() in judge-score-fanout handles conversion.
      final_status: z.union([z.string(), z.number()]),
      metrics: z.array(metricStatisticsSchema),
    })
  ),
});
