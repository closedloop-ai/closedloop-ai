import { z } from "zod";

export const submitPullRequestRatingSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((val) => val.trim().length > 0, {
      message: "Comment cannot be whitespace only",
    }),
});

export type SubmitPullRequestRatingInput = z.infer<
  typeof submitPullRequestRatingSchema
>;
