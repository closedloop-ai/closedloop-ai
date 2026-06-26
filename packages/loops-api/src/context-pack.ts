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
  raw?: Record<string, unknown>;
};

export const ContextPackArtifactSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  content: z.string(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

// Direct referenced artifacts that should be treated as supporting evidence.
// These intentionally duplicate full artifact content that may also exist in
// `artifacts`: ECS and Desktop materializers need an explicit, transport-safe
// list of source-of-truth refs while older consumers keep reading `artifacts`.
export type ContextPackSupportingArtifact = ContextPackArtifact;

export const ContextPackSupportingArtifactSchema = ContextPackArtifactSchema;

export type CodeEvaluationContext = {
  schemaVersion: 1;
  repo?: {
    fullName?: string | null;
    branch?: string | null;
  } | null;
  localRepoPath?: string | null;
  parentBranchName?: string | null;
  parentSessionId?: string | null;
  artifactSlug?: string | null;
  pullRequest?: {
    number?: number | null;
    url?: string | null;
    headBranch?: string | null;
    baseBranch?: string | null;
    headSha?: string | null;
    repositoryFullName?: string | null;
  } | null;
  detected?: {
    branch?: string | null;
    headSha?: string | null;
    gitDetectionError?: string | null;
  } | null;
};

export const CodeEvaluationContextSchema = z.object({
  schemaVersion: z.literal(1),
  repo: z
    .object({
      fullName: z.string().nullable().optional(),
      branch: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  localRepoPath: z.string().nullable().optional(),
  parentBranchName: z.string().nullable().optional(),
  parentSessionId: z.string().nullable().optional(),
  artifactSlug: z.string().nullable().optional(),
  pullRequest: z
    .object({
      number: z.number().nullable().optional(),
      url: z.string().nullable().optional(),
      headBranch: z.string().nullable().optional(),
      baseBranch: z.string().nullable().optional(),
      headSha: z.string().nullable().optional(),
      repositoryFullName: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  detected: z
    .object({
      branch: z.string().nullable().optional(),
      headSha: z.string().nullable().optional(),
      gitDetectionError: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
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

export type ContextPackAgent = {
  slug: string;
  name: string;
  prompt: string;
};

export const ContextPackAgentSchema = z.object({
  slug: z.string(),
  name: z.string(),
  prompt: z.string(),
});

export type ContextPackRepoConfig = {
  repoFullName: string;
  criticGates: Record<string, unknown>;
};

export const ContextPackRepoConfigSchema = z.object({
  repoFullName: z.string(),
  criticGates: z.record(z.string(), z.unknown()),
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
  supportingArtifacts?: ContextPackSupportingArtifact[];
  codeEvaluationContext?: CodeEvaluationContext;
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
  agents?: ContextPackAgent[];
  repoConfigs?: ContextPackRepoConfig[];
};

export const ContextPackSchema = z.object({
  command: z.string(),
  prompt: z.string().optional(),
  artifacts: z.array(ContextPackArtifactSchema),
  supportingArtifacts: z.array(ContextPackSupportingArtifactSchema).optional(),
  codeEvaluationContext: CodeEvaluationContextSchema.optional(),
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
  agents: z.array(ContextPackAgentSchema).optional(),
  repoConfigs: z.array(ContextPackRepoConfigSchema).optional(),
});
