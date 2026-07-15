import { z } from "zod";
import {
  GITHUB_DIRTY_SCOPE_COMMAND_TIMEOUT_MS as GITHUB_DIRTY_SCOPE_COMMAND_TIMEOUT_MS_VALUE,
  GITHUB_DIRTY_SCOPE_MAX_SCOPES_PER_REPO as GITHUB_DIRTY_SCOPE_MAX_SCOPES_PER_REPO_VALUE,
  GITHUB_RESYNC_NUDGE_METHOD as GITHUB_RESYNC_NUDGE_METHOD_VALUE,
  GITHUB_RESYNC_NUDGE_OPERATION_ID as GITHUB_RESYNC_NUDGE_OPERATION_ID_VALUE,
  GITHUB_RESYNC_NUDGE_PATH as GITHUB_RESYNC_NUDGE_PATH_VALUE,
  type GitHubDirtyFallbackReason as GitHubDirtyFallbackReasonType,
  GitHubDirtyFallbackReason as GitHubDirtyFallbackReasonValue,
  type GitHubDirtyScopeKind as GitHubDirtyScopeKindType,
  GitHubDirtyScopeKind as GitHubDirtyScopeKindValue,
  type GitHubDirtyScope as GitHubDirtyScopeType,
  type GitHubDirtyTrigger as GitHubDirtyTriggerType,
  GitHubDirtyTrigger as GitHubDirtyTriggerValue,
  type GitHubResyncNudgeBody as GitHubResyncNudgeBodyType,
} from "./github-dirty-scope-constants.ts";

export const GITHUB_DIRTY_SCOPE_COMMAND_TIMEOUT_MS =
  GITHUB_DIRTY_SCOPE_COMMAND_TIMEOUT_MS_VALUE;
export const GITHUB_DIRTY_SCOPE_MAX_SCOPES_PER_REPO =
  GITHUB_DIRTY_SCOPE_MAX_SCOPES_PER_REPO_VALUE;
export const GITHUB_RESYNC_NUDGE_METHOD = GITHUB_RESYNC_NUDGE_METHOD_VALUE;
export const GITHUB_RESYNC_NUDGE_OPERATION_ID =
  GITHUB_RESYNC_NUDGE_OPERATION_ID_VALUE;
export const GITHUB_RESYNC_NUDGE_PATH = GITHUB_RESYNC_NUDGE_PATH_VALUE;
export const GitHubDirtyFallbackReason = GitHubDirtyFallbackReasonValue;
export const GitHubDirtyScopeKind = GitHubDirtyScopeKindValue;
export const GitHubDirtyTrigger = GitHubDirtyTriggerValue;

export type GitHubDirtyFallbackReason = GitHubDirtyFallbackReasonType;
export type GitHubDirtyScope = GitHubDirtyScopeType;
export type GitHubDirtyScopeKind = GitHubDirtyScopeKindType;
export type GitHubDirtyTrigger = GitHubDirtyTriggerType;
export type GitHubResyncNudgeBody = GitHubResyncNudgeBodyType;

const dirtyScopeKindValidator = z.enum(Object.values(GitHubDirtyScopeKind));
const dirtyTriggerValidator = z.enum(Object.values(GitHubDirtyTrigger));
const fallbackReasonValidator = z.enum(
  Object.values(GitHubDirtyFallbackReason)
);

export const gitHubDirtyScopeValidator = z
  .object({
    kind: dirtyScopeKindValidator,
    repositoryId: z.string().trim().min(1).optional(),
    repositoryFullName: z.string().trim().min(1).optional(),
    branchName: z.string().trim().min(1).optional(),
    pullRequestNumber: z.number().int().positive().optional(),
    reviewId: z.string().trim().min(1).optional(),
    commentId: z.string().trim().min(1).optional(),
    checkRunId: z.string().trim().min(1).optional(),
  })
  .strip();

export const gitHubDirtyScopesValidator = z
  .array(gitHubDirtyScopeValidator)
  .min(1)
  .max(GITHUB_DIRTY_SCOPE_MAX_SCOPES_PER_REPO);

export const githubResyncNudgeBodyValidator = z
  .object({
    scopes: gitHubDirtyScopesValidator,
    triggers: z.array(dirtyTriggerValidator).min(1).optional(),
    fallbackReason: fallbackReasonValidator.optional(),
    computeTargetId: z.string().trim().min(1).optional(),
    gatewayId: z.string().trim().min(1).optional(),
    profileId: z.string().trim().min(1).optional(),
  })
  .strip();

export type GitHubResyncNudgeParseResult =
  | { ok: true; body: GitHubResyncNudgeBody }
  | {
      ok: false;
      body: GitHubResyncNudgeBody;
      reason: GitHubDirtyFallbackReason;
    };

/** Parses additive dirty-scope payloads with a conservative generic fallback. */
export function parseGitHubResyncNudgeBody(
  value: unknown
): GitHubResyncNudgeParseResult {
  const parsed = githubResyncNudgeBodyValidator.safeParse(value);
  if (parsed.success) {
    return { ok: true, body: omitAbsentNudgeOptionals(parsed.data) };
  }

  const reason = hasScopeOverflow(value)
    ? GitHubDirtyFallbackReason.ScopeOverflow
    : GitHubDirtyFallbackReason.MalformedPayload;
  return {
    ok: false,
    reason,
    body: buildGenericGitHubResyncNudgeBody(
      reason,
      extractTargetContext(value)
    ),
  };
}

export function buildGenericGitHubResyncNudgeBody(
  fallbackReason: GitHubDirtyFallbackReason,
  targetContext: Partial<
    Pick<GitHubResyncNudgeBody, "computeTargetId" | "gatewayId" | "profileId">
  > = {}
): GitHubResyncNudgeBody {
  return omitAbsentNudgeOptionals({
    scopes: [{ kind: GitHubDirtyScopeKind.Generic }],
    fallbackReason,
    ...targetContext,
  });
}

export function omitAbsentNudgeOptionals(
  body: GitHubResyncNudgeBody
): GitHubResyncNudgeBody {
  return JSON.parse(JSON.stringify(body)) as GitHubResyncNudgeBody;
}

function hasScopeOverflow(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const scopes = (value as { scopes?: unknown }).scopes;
  return (
    Array.isArray(scopes) &&
    scopes.length > GITHUB_DIRTY_SCOPE_MAX_SCOPES_PER_REPO
  );
}

const targetContextValidator = z
  .object({
    computeTargetId: z.string().trim().min(1).optional(),
    gatewayId: z.string().trim().min(1).optional(),
    profileId: z.string().trim().min(1).optional(),
  })
  .strip();

function extractTargetContext(
  value: unknown
): Partial<
  Pick<GitHubResyncNudgeBody, "computeTargetId" | "gatewayId" | "profileId">
> {
  const parsed = targetContextValidator.safeParse(value);
  return parsed.success ? parsed.data : {};
}
