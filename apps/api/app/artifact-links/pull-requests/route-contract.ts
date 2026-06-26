import { GitHubPRState } from "@repo/api/src/types/github";
import { z } from "zod";

export const createPrArtifactValidator = z.object({
  projectId: z.uuid(),
  title: z.string().min(1),
  externalUrl: z.string().min(1),
  number: z.number().int().positive(),
  githubId: z.string().min(1),
  headBranch: z.string().min(1),
  baseBranch: z.string().min(1),
  headSha: z.string().trim().min(1).nullable().optional(),
  state: z.enum(GitHubPRState),
  isDraft: z.boolean().optional(),
  closedAt: z.string().datetime().nullable().optional(),
  mergedAt: z.string().datetime().nullable().optional(),
  mergeCommitSha: z.string().trim().min(1).nullable().optional(),
});

export type CreatePrArtifactInput = z.infer<typeof createPrArtifactValidator>;

export type CreatePrArtifactResponse = { id: string };
