import { DATE_ONLY_REGEX } from "@repo/api/src/constants";
import { EVALUATION_REPORT_TYPE_OPTIONS } from "@repo/api/src/types/evaluation";
import {
  ARTIFACT_COUNTS_GROUP_BY_OPTIONS,
  PR_TIMELINE_GRANULARITY_OPTIONS,
  type PrTimelineGranularity,
} from "@repo/api/src/types/judges-analytics";
import { z } from "zod";

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
  reportType: z.enum(EVALUATION_REPORT_TYPE_OPTIONS),
});

export const artifactCountsQueryValidator = dateRangeQueryValidator.extend({
  groupBy: z.enum(ARTIFACT_COUNTS_GROUP_BY_OPTIONS),
});

export const scoreComparisonQueryValidator = z.object({
  reportType: z.enum(EVALUATION_REPORT_TYPE_OPTIONS),
  page: z.string().default("1").transform(Number).pipe(z.number().int().min(1)),
  pageSize: z
    .string()
    .default("20")
    .transform(Number)
    .pipe(z.number().int().min(1).max(100)),
});

export const prHealthQueryValidator = dateRangeQueryValidator
  .extend({
    granularity: z
      .enum(
        Object.values(PR_TIMELINE_GRANULARITY_OPTIONS) as [
          PrTimelineGranularity,
          ...PrTimelineGranularity[],
        ]
      )
      .default(PR_TIMELINE_GRANULARITY_OPTIONS.Week),
    reportType: z.enum(EVALUATION_REPORT_TYPE_OPTIONS),
  })
  .refine(
    (data) => {
      const start = new Date(data.startDate);
      const end = new Date(data.endDate);
      return (end.getTime() - start.getTime()) / 86_400_000 <= 365;
    },
    { message: "Date range must not exceed 365 days" }
  );

/** Parse YYYY-MM-DD strings to UTC start-of-day and end-of-day Date objects. */
export function parseDateRange(startDate: string, endDate: string) {
  return {
    startDate: new Date(`${startDate}T00:00:00.000Z`),
    endDate: new Date(`${endDate}T23:59:59.999Z`),
  };
}
