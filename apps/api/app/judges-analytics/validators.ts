import { z } from "zod";

// YYYY-MM-DD format validation
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const queryParamsSchema = z
  .object({
    startDate: z
      .string()
      .regex(DATE_REGEX, "startDate must be in YYYY-MM-DD format"),
    endDate: z
      .string()
      .regex(DATE_REGEX, "endDate must be in YYYY-MM-DD format"),
  })
  .refine((data) => data.startDate <= data.endDate, {
    message: "startDate must be less than or equal to endDate",
  });
