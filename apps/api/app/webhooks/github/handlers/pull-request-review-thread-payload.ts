import { z } from "zod";

const nullableGitHubUserSchema = z
  .object({
    id: z.union([z.number(), z.string()]).nullable().optional(),
    node_id: z.string().nullable().optional(),
    login: z.string().nullable().optional(),
    avatar_url: z.string().nullable().optional(),
    html_url: z.string().nullable().optional(),
  })
  .nullable();

const reviewThreadCommentSchema = z.object({
  id: z.union([z.number(), z.string()]).nullable().optional(),
  node_id: z.string().nullable().optional(),
});

const pullRequestReviewThreadPayloadSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }).optional(),
  repository: z.object({
    id: z.number(),
    full_name: z.string(),
  }),
  pull_request: z.object({
    number: z.number(),
    title: z.string(),
    html_url: z.string(),
  }),
  thread: z.object({
    node_id: z.string().min(1),
    comments: z.array(reviewThreadCommentSchema).optional().default([]),
  }),
  sender: nullableGitHubUserSchema.optional(),
});

export type PullRequestReviewThreadPayload = z.infer<
  typeof pullRequestReviewThreadPayloadSchema
>;

/**
 * Parse the subset of GitHub's pull_request_review_thread payload consumed by
 * resolution sync. The adapter deliberately does not require `thread.updated_at`
 * because the installed webhook type package does not expose it for this event.
 */
export function parsePullRequestReviewThreadPayload(
  payload: unknown
): PullRequestReviewThreadPayload | null {
  const parsed = pullRequestReviewThreadPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
