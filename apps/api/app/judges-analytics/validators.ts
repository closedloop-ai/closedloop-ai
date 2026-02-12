import { DATE_ONLY_REGEX } from "@repo/api/src/constants";
import { ARTIFACT_COUNTS_GROUP_BY_OPTIONS } from "@repo/api/src/types/judges-analytics";
import { z } from "zod";

export const judgesAnalyticsQueryValidator = z
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

export const artifactCountsQueryValidator =
  judgesAnalyticsQueryValidator.extend({
    groupBy: z.enum(ARTIFACT_COUNTS_GROUP_BY_OPTIONS),
  });

/** Parse YYYY-MM-DD strings to UTC start-of-day and end-of-day Date objects. */
export function parseDateRange(startDate: string, endDate: string) {
  return {
    startDate: new Date(`${startDate}T00:00:00.000Z`),
    endDate: new Date(`${endDate}T23:59:59.999Z`),
  };
}
