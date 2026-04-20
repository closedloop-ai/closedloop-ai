import { z } from "zod";

// Context pack attachment (file uploaded to S3 with signed URL)
export type ContextPackAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  signedUrl: string;
  signedUrlExpiresAt: string;
};

export const ContextPackAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  signedUrl: z.string(),
  signedUrlExpiresAt: z.string(),
});

// Context pack artifact entry
export type ContextPackArtifact = {
  id: string;
  type: string;
  title: string;
  content: string;
};

export const ContextPackArtifactSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  content: z.string(),
});

// Additional repository reference for multi-repo loop execution
export type AdditionalRepoRef = {
  fullName: string;
  branch: string;
};

// Format constraints mirror the write-path `repoSchema` in
// apps/api/app/loops/validators.ts so data round-tripped through the DB is
// held to the same shape it was validated with on write.
export const AdditionalRepoRefSchema = z.object({
  fullName: z
    .string()
    .min(1)
    .max(256)
    .regex(
      /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/,
      "Must be in 'owner/repo' format"
    ),
  branch: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9._/-]+$/, "Branch name contains invalid characters"),
});

// Additional repository reference with optional GitHub token
export type AdditionalRepoRefWithToken = AdditionalRepoRef & {
  githubToken?: string;
};

export const AdditionalRepoRefWithTokenSchema = AdditionalRepoRefSchema.extend({
  githubToken: z.string().optional(),
});

/**
 * Context pack — the input payload assembled by the backend and consumed
 * by the ECS runner harness (via S3) or desktop gateway (via relay).
 *
 * Canonical source: apps/api/lib/loops/loop-state.ts
 */
export type ContextPack = {
  command: string;
  prompt?: string;
  artifacts: ContextPackArtifact[];
  repoInfo?: { fullName: string; branch: string };
  priorLoopSummaries?: Array<{
    loopId: string;
    command: string;
    summary: string;
  }>;
  committer?: { name: string; email: string };
  secrets?: { anthropicApiKey?: string; githubToken?: string };
  userContext?: string;
  attachments?: ContextPackAttachment[];
  additionalRepos?: AdditionalRepoRefWithToken[];
};

export const ContextPackSchema = z.object({
  command: z.string(),
  prompt: z.string().optional(),
  artifacts: z.array(ContextPackArtifactSchema),
  repoInfo: z
    .object({
      fullName: z.string(),
      branch: z.string(),
    })
    .optional(),
  priorLoopSummaries: z
    .array(
      z.object({
        loopId: z.string(),
        command: z.string(),
        summary: z.string(),
      })
    )
    .optional(),
  committer: z
    .object({
      name: z.string(),
      email: z.string(),
    })
    .optional(),
  secrets: z
    .object({
      anthropicApiKey: z.string().optional(),
      githubToken: z.string().optional(),
    })
    .optional(),
  userContext: z.string().optional(),
  attachments: z.array(ContextPackAttachmentSchema).optional(),
  additionalRepos: z.array(AdditionalRepoRefWithTokenSchema).optional(),
});
