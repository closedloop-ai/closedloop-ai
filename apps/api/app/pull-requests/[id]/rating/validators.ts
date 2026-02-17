import { z } from "zod";

export const submitPullRequestRatingSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
});

export type SubmitPullRequestRatingInput = z.infer<
  typeof submitPullRequestRatingSchema
>;
