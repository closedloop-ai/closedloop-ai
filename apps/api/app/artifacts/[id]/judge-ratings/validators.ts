import { z } from "zod";

export const submitJudgeRatingValidator = z.object({
  judgeScoreId: z.string().uuid(),
  rating: z
    .number()
    .min(0)
    .max(1)
    .refine((v) => Number(v.toFixed(2)) === v, {
      message: "rating must have at most 2 decimal places",
    }),
});
