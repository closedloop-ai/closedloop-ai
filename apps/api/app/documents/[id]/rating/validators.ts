import { z } from "zod";

export const submitRatingSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z
    .string()
    .max(500)
    .optional()
    .transform((val) => val?.trim() || undefined),
});

export type SubmitRatingInput = z.infer<typeof submitRatingSchema>;
