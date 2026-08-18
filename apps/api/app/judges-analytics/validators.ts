import { DATE_ONLY_REGEX } from "@repo/api/src/constants";
import {
  EVALUATION_REPORT_TYPE_INPUT_OPTIONS,
  normalizeEvaluationReportType,
} from "@repo/api/src/types/evaluation";
import { DOCUMENT_COUNTS_GROUP_BY_OPTIONS } from "@repo/api/src/types/judges-analytics";
import { z } from "zod";

// FEA-3956: accept the canonical `ISSUE` report-type alias from a skewed newer
// client and normalize it to the persisted `FEATURE` discriminator before it
// reaches the service's raw `::"EvaluationReportType"` query, so `ISSUE` targets
// stored `FEATURE` evaluations instead of 400ing or returning an empty set.
const reportTypeInputSchema = z
  .enum(EVALUATION_REPORT_TYPE_INPUT_OPTIONS)
  .transform(normalizeEvaluationReportType);

const dateRangeQueryValidator = z
  .object({
    startDate: z
      .string()
      .regex(DATE_ONLY_REGEX, "startDate must be in YYYY-MM-DD format"),
    endDate: z
      .string()
      .regex(DATE_ONLY_REGEX, "endDate must be in YYYY-MM-DD format"),
  })
  .refine((data) => data.startDate <= data.endDate, {
    message: "startDate must be less than or equal to endDate",
  });

export const judgesAnalyticsQueryValidator = dateRangeQueryValidator.extend({
  reportType: reportTypeInputSchema,
});

export const artifactCountsQueryValidator = dateRangeQueryValidator.extend({
  groupBy: z.enum(DOCUMENT_COUNTS_GROUP_BY_OPTIONS),
});

export const scoreComparisonQueryValidator = z.object({
  reportType: reportTypeInputSchema,
  page: z.string().default("1").transform(Number).pipe(z.number().int().min(1)),
  pageSize: z
    .string()
    .default("20")
    .transform(Number)
    .pipe(z.number().int().min(1).max(100)),
});

/** Parse YYYY-MM-DD strings to UTC start-of-day and end-of-day Date objects. */
export function parseDateRange(startDate: string, endDate: string) {
  return {
    startDate: new Date(`${startDate}T00:00:00.000Z`),
    endDate: new Date(`${endDate}T23:59:59.999Z`),
  };
}
