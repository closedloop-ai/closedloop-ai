import { hasAtMostDecimalPlaces } from "@repo/api/src/utils/math";
import { z } from "zod";

export const submitJudgeRatingValidator = z.object({
  judgeScoreId: z.uuid(),
  rating: z
    .number()
    .min(0)
    .max(1)
    .refine((v) => hasAtMostDecimalPlaces(v, 2), {
      message: "rating must have at most 2 decimal places",
    }),
});
