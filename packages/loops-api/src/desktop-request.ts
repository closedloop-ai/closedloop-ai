import { z } from "zod";
import { LoopArtifactType } from "./artifacts";
import type { LoopCommand } from "./commands";
import { LoopCommandSchema } from "./commands";
import type {
  CodeEvaluationContext,
  ContextPackAgent,
  ContextPackAttachment,
  ContextPackRepoConfig,
  ContextPackSupportingArtifact,
} from "./context-pack";
import {
  CodeEvaluationContextSchema,
  ContextPackAgentSchema,
  ContextPackAttachmentSchema,
  ContextPackRepoConfigSchema,
  ContextPackSupportingArtifactSchema,
} from "./context-pack";

/**
 * The AI agent harness to use when executing a loop on the Desktop gateway.
 * Defaults to "claude" at runtime when not provided.
 */
export const LoopHarness = {
  Claude: "claude",
  Codex: "codex",
  Cursor: "cursor",
  OpenCode: "opencode",
} as const;
export type LoopHarness = (typeof LoopHarness)[keyof typeof LoopHarness];
export const LoopHarnessSchema = z.enum(LoopHarness).catch(LoopHarness.Claude);

/** Which repo in a multi-repo loop a materialized output branch belongs to. */
export const LoopBranchMaterializationRole = {
  Primary: "primary",
  Additional: "additional",
} as const;
export type LoopBranchMaterializationRole =
  (typeof LoopBranchMaterializationRole)[keyof typeof LoopBranchMaterializationRole];

/** Server-owned branch destination for one repo in a Desktop loop. */
export type LoopBranchMaterializationEntry = {
  role: LoopBranchMaterializationRole;
  repositoryFullName: string;
  baseBranch: string;
  branchName: string;
};

/**
 * Additive Desktop loop contract carrying the exact output branches Symphony
 * expects Desktop to materialize and report back through branch-artifact
 * callbacks.
 */
export type LoopBranchMaterializationEnvelope = {
  schemaVersion: 1;
  branches: LoopBranchMaterializationEntry[];
};

export const LoopBranchMaterializationEntrySchema = z.object({
  role: z.enum(LoopBranchMaterializationRole),
  repositoryFullName: z.string(),
  baseBranch: z.string(),
  branchName: z.string(),
});

export const LoopBranchMaterializationEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  branches: z.array(LoopBranchMaterializationEntrySchema),
});

/**
 * THE loop wire contract between the cloud dispatcher and the Desktop gateway.
 *
 * This is the single declaration of that payload. The producer side does not
 * restate it: `LoopBody` in `packages/api/src/types/loop-body.ts` is *derived*
 * from this type, so a field cannot reach the dispatcher (or the runtime)
 * without first being declared here, where the Desktop parser reads it. Before
 * ISS-5154 the two were independent declarations, which is how `s3StateKey`
 * shipped to the producer and the runtime while this type never learned about
 * it — the drift wongk flagged in review on #4447.
 *
 * Cross-repo rules for changing it: every new field is additive and optional,
 * absent values degrade to a safe default rather than throwing, and omission is
 * preserved on the wire (an absent optional is not serialized as `null`), so an
 * older Desktop build and an older dispatcher both keep working.
 *
 * Shape note: this is a flattened version of context pack + loop metadata —
 * NOT the same shape as ContextPack (S3 transport).
 */
export type LoopRequestBody = {
  loopId: string;
  command: LoopCommand;
  closedLoopAuthToken: string;
  apiBaseUrl?: string;
  /**
   * S3 prefix the loop's run state is checkpointed under. Sent by the cloud
   * dispatcher (`buildDesktopLoopExecutionBody`) and persisted by the desktop
   * gateway onto the `LocalJob`, so a support-bundle upload after a crash can
   * name the run's state. Optional: an older dispatcher omits it, and the
   * gateway then keeps whatever key the existing job already carries.
   */
  s3StateKey?: string;
  artifacts: Array<{
    id: string;
    type: LoopArtifactType;
    title: string;
    content: string;
    raw?: Record<string, unknown>;
  }>;
  repo?: { fullName: string; branch: string };
  committer?: { name: string; email: string };
  artifactSlug?: string;
  parentLoopId?: string;
  parentBranchName?: string;
  parentSessionId?: string;
  prompt?: string;
  localRepoPath?: string;
  /**
   * Additional repositories to check out alongside the primary repo.
   * Accepted and validated by this schema but not yet forwarded to compute
   * targets; propagation is tracked in a follow-on PR.
   * An empty array is valid (no additional repos).
   */
  additionalRepos?: Array<
    | { localRepoPath: string; fullName?: string; branch: string }
    | { localRepoPath?: string; fullName: string; branch: string }
  >;
  userContext?: string;
  attachments?: ContextPackAttachment[];
  supportingArtifacts?: ContextPackSupportingArtifact[];
  codeEvaluationContext?: CodeEvaluationContext | null;
  primaryArtifactId?: string;
  agents?: ContextPackAgent[];
  repoConfigs?: ContextPackRepoConfig[];
  /**
   * Exact output branches Symphony expects Desktop to materialize. Sent by the
   * cloud dispatcher; optional because an older dispatcher omits it, in which
   * case Desktop falls back to naming branches itself.
   */
  branchMaterialization?: LoopBranchMaterializationEnvelope;
  /**
   * AI agent harness to use for this loop execution.
   * Defaults to "claude" at runtime when not provided.
   */
  harness?: LoopHarness;
};

/**
 * Compile-time coverage guard for the schema shape below.
 *
 * `satisfies Record<keyof LoopRequestBody, z.ZodTypeAny>` makes the shape total
 * over the contract: adding a field to `LoopRequestBody` without adding it here
 * fails `tsc`, and so does a schema key the type does not declare. Without it a
 * new field parses as an unknown key and is silently stripped — the same class
 * of silent loss as the `.strict()`-boundary drift in AGENTS.md.
 */
type LoopRequestBodySchemaShape = Record<keyof LoopRequestBody, z.ZodTypeAny>;

export const LoopRequestBodySchema = z.object({
  loopId: z.string(),
  command: LoopCommandSchema,
  closedLoopAuthToken: z.string(),
  apiBaseUrl: z.string().optional(),
  s3StateKey: z.string().optional(),
  artifacts: z.array(
    z.object({
      id: z.string(),
      type: z.enum(LoopArtifactType),
      title: z.string(),
      content: z.string(),
      raw: z.record(z.string(), z.unknown()).optional(),
    })
  ),
  repo: z
    .object({
      fullName: z.string(),
      branch: z.string(),
    })
    .optional(),
  committer: z
    .object({
      name: z.string(),
      email: z.string(),
    })
    .optional(),
  artifactSlug: z.string().optional(),
  parentLoopId: z.string().optional(),
  parentBranchName: z.string().optional(),
  parentSessionId: z.string().optional(),
  prompt: z.string().optional(),
  localRepoPath: z.string().optional(),
  userContext: z.string().optional(),
  additionalRepos: z
    .array(
      z
        .object({
          localRepoPath: z.string().min(1).optional(),
          fullName: z.string().min(1).optional(),
          branch: z.string(),
        })
        .refine(
          (obj) =>
            obj.localRepoPath !== undefined || obj.fullName !== undefined,
          {
            message:
              "At least one of localRepoPath or fullName must be provided",
            path: ["localRepoPath"],
          }
        )
    )
    .optional(),
  attachments: z.array(ContextPackAttachmentSchema).optional(),
  supportingArtifacts: z.array(ContextPackSupportingArtifactSchema).optional(),
  codeEvaluationContext: CodeEvaluationContextSchema.nullable().optional(),
  primaryArtifactId: z.string().optional(),
  agents: z.array(ContextPackAgentSchema).optional(),
  repoConfigs: z.array(ContextPackRepoConfigSchema).optional(),
  branchMaterialization: LoopBranchMaterializationEnvelopeSchema.optional(),
  harness: LoopHarnessSchema.optional(),
} satisfies LoopRequestBodySchemaShape);
