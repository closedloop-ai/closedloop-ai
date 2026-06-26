import { z } from "zod";

// --- Const-object enums (no `enum` keyword per codebase conventions) ---

export const SessionPrRelationType = {
  Created: "CREATED",
  Referenced: "REFERENCED",
} as const;
export type SessionPrRelationType =
  (typeof SessionPrRelationType)[keyof typeof SessionPrRelationType];

export const SessionPrLinkSource = {
  Deterministic: "DETERMINISTIC",
} as const;
export type SessionPrLinkSource =
  (typeof SessionPrLinkSource)[keyof typeof SessionPrLinkSource];

export const ArtifactRefMethod = {
  McpToolCall: "mcp_tool_call",
  UrlInMessage: "url_in_message",
  SlugInMessage: "slug_in_message",
  SlugInBranch: "slug_in_branch",
  SlugInCwd: "slug_in_cwd",
  SlugInSessionSlug: "slug_in_session_slug",
  PrCreateOutput: "pr_create_output",
  PrUrlInToolUse: "pr_url_in_tool_use",
  LaunchMetadata: "launch_metadata",
  GitCommand: "git_command",
} as const;
export type ArtifactRefMethod =
  (typeof ArtifactRefMethod)[keyof typeof ArtifactRefMethod];

export const ArtifactRefTargetKind = {
  ClosedloopArtifact: "closedloop_artifact",
  PullRequest: "pull_request",
  Branch: "branch",
  Commit: "commit",
} as const;
export type ArtifactRefTargetKind =
  (typeof ArtifactRefTargetKind)[keyof typeof ArtifactRefTargetKind];

export const ArtifactRefRelation = {
  Input: "input",
  Output: "output",
  Referenced: "referenced",
  Created: "created",
  Workspace: "workspace",
} as const;
export type ArtifactRefRelation =
  (typeof ArtifactRefRelation)[keyof typeof ArtifactRefRelation];

export const ArtifactRefConfidence = {
  McpCall: "mcp_call",
  UrlMatch: "url_match",
  SlugMatchInProse: "slug_match_in_prose",
  SlugMatchInBranch: "slug_match_in_branch",
} as const;
export type ArtifactRefConfidence =
  (typeof ArtifactRefConfidence)[keyof typeof ArtifactRefConfidence];

// --- Zod validators for sync contract ---

const CLOSEDLOOP_SLUG_RE = /^(PRD|FEA|PLN|PRO|WRK|SES)-\d{1,5}$/;

export const syncedArtifactRefSchema = z.object({
  slug: z.string().regex(CLOSEDLOOP_SLUG_RE).max(200),
  isPrimary: z.boolean(),
  method: z.string().min(1).max(200),
});
export type SyncedArtifactRef = z.infer<typeof syncedArtifactRefSchema>;

export const syncedSessionPrRefSchema = z.object({
  repositoryFullName: z.string().min(1).max(200),
  prNumber: z.number().int().positive(),
  // Accepted for backward compatibility but ignored — the server derives the
  // canonical prUrl from repositoryFullName + prNumber to prevent forgery.
  prUrl: z.string().url().max(200).optional(),
  relationType: z.enum([
    SessionPrRelationType.Created,
    SessionPrRelationType.Referenced,
  ]),
});
export type SyncedSessionPrRef = z.infer<typeof syncedSessionPrRefSchema>;

// --- Cloud attribution-join query DTO ---

export type ArtifactSessionUsageByModel = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
};

export type ArtifactSessionUsageSummary = {
  artifactId: string;
  artifactSlug: string | null;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  byModel: ArtifactSessionUsageByModel[];
};

// --- Local SQLite attribution-join query result ---

export type LocalArtifactSessionUsage = {
  artifactSlug: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
};
