import { z } from "zod";
import { GitHubAccessDenialReason } from "./github.ts";
import {
  type PullRequestLabelSpec,
  pullRequestLabelSpecListValidator,
} from "./pull-request-label.ts";
import { PullRequestLabelSyncStatus } from "./pull-request-label-sync-status.ts";

export const DesktopGithubPullRequestApiPath = {
  PullRequest: "/desktop/github/pull-request",
  PullRequestUpdatePrefix: "/desktop/github/pull-request/",
  LegacyGatewayPullRequest: "/api/gateway/git/pr",
  LegacyGatewayGitUser: "/api/gateway/git/user",
} as const;
export type DesktopGithubPullRequestApiPath =
  (typeof DesktopGithubPullRequestApiPath)[keyof typeof DesktopGithubPullRequestApiPath];

export const DesktopGithubPullRequestContractVersion = 1;
export const DesktopGithubPullRequestRequestMaxBytes = 262_144;
export const DesktopGithubPullRequestBodyMaxLength = 65_536;
export const DesktopGithubPullRequestApiMaxDurationSeconds = 30;
export const DesktopGithubPullRequestApiTimeoutMs =
  DesktopGithubPullRequestApiMaxDurationSeconds * 1000;

export const DesktopGithubPullRequestMode = {
  Preflight: "preflight",
  Create: "create",
} as const;
export type DesktopGithubPullRequestMode =
  (typeof DesktopGithubPullRequestMode)[keyof typeof DesktopGithubPullRequestMode];

export const DesktopGithubPullRequestSuccessMode = {
  Preflight: "preflight",
  Create: "create",
  Update: "update",
} as const;
export type DesktopGithubPullRequestSuccessMode =
  (typeof DesktopGithubPullRequestSuccessMode)[keyof typeof DesktopGithubPullRequestSuccessMode];

export const DesktopGithubPullRequestStatus = {
  Available: "available",
  Created: "created",
  Existing: "existing",
  Updated: "updated",
} as const;
export type DesktopGithubPullRequestStatus =
  (typeof DesktopGithubPullRequestStatus)[keyof typeof DesktopGithubPullRequestStatus];

export const DesktopGithubPullRequestStage = {
  LocalPreflight: "local_preflight",
  ApiPreflight: "api_preflight",
  GitPush: "git_push",
  ApiCreate: "api_create",
  ApiUpdate: "api_update",
  Provider: "provider",
} as const;
export type DesktopGithubPullRequestStage =
  (typeof DesktopGithubPullRequestStage)[keyof typeof DesktopGithubPullRequestStage];

export const DesktopGithubPullRequestReason = {
  ApiIncompatible: "api_incompatible",
  OperationUnavailable: "operation_unavailable",
  TransientUnavailable: "transient_unavailable",
  AuthenticationRequired: "authentication_required",
  AuthorizationDenied: "authorization_denied",
  RepositoryUnavailable: "repository_unavailable",
  BranchUnavailable: "branch_unavailable",
  /** Requested pull request number is not visible to the authenticated user. */
  PullRequestUnavailable: "pull_request_unavailable",
  /** GitHub reports an existing or ambiguous pull request for this head. */
  PullRequestAlreadyExists: "pull_request_already_exists",
  ValidationFailed: "validation_failed",
  ProviderRejected: "provider_rejected",
  ProviderRateLimited: "provider_rate_limited",
  InternalError: "internal_error",
} as const;
export type DesktopGithubPullRequestReason =
  (typeof DesktopGithubPullRequestReason)[keyof typeof DesktopGithubPullRequestReason];

export const DesktopGithubPullRequestErrorCode = {
  ApiIncompatible: "desktop_github_pr_api_incompatible",
  OperationUnavailable: "desktop_github_pr_operation_unavailable",
  AuthenticationRequired: "desktop_github_pr_authentication_required",
  AuthorizationDenied: "desktop_github_pr_authorization_denied",
  RepositoryUnavailable: "desktop_github_pr_repository_unavailable",
  BranchUnavailable: "desktop_github_pr_branch_unavailable",
  PullRequestUnavailable: "desktop_github_pr_pull_request_unavailable",
  PullRequestAlreadyExists: "desktop_github_pr_already_exists",
  ValidationFailed: "desktop_github_pr_validation_failed",
  ProviderRejected: "desktop_github_pr_provider_rejected",
  ProviderRateLimited: "desktop_github_pr_provider_rate_limited",
  TransientUnavailable: "desktop_github_pr_transient_unavailable",
  InternalError: "desktop_github_pr_internal_error",
} as const;
export type DesktopGithubPullRequestErrorCode =
  (typeof DesktopGithubPullRequestErrorCode)[keyof typeof DesktopGithubPullRequestErrorCode];

const REPOSITORY_FULL_NAME_REGEX = /^[^/\s]+\/[^/\s]+$/;
const repoFullNameSchema = z
  .string()
  .trim()
  .regex(REPOSITORY_FULL_NAME_REGEX, "repoFullName must be owner/repo");

const branchNameSchema = z.string().trim().min(1);

const pullRequestRequestBaseSchema = z.object({
  contractVersion: z.literal(DesktopGithubPullRequestContractVersion),
  repoFullName: repoFullNameSchema,
  headRepoFullName: repoFullNameSchema.optional(),
});

export const desktopGithubPullRequestPreflightRequestSchema =
  pullRequestRequestBaseSchema
    .extend({
      mode: z.literal(DesktopGithubPullRequestMode.Preflight),
    })
    .strict();

export const desktopGithubPullRequestCreateRequestSchema =
  pullRequestRequestBaseSchema
    .extend({
      mode: z.literal(DesktopGithubPullRequestMode.Create),
      headBranch: branchNameSchema,
      baseBranch: branchNameSchema.optional(),
      title: z.string().trim().min(1),
      body: z.string().max(DesktopGithubPullRequestBodyMaxLength),
      labels: pullRequestLabelSpecListValidator.optional(),
    })
    .strict();

export const desktopGithubPullRequestRequestSchema = z.discriminatedUnion(
  "mode",
  [
    desktopGithubPullRequestPreflightRequestSchema,
    desktopGithubPullRequestCreateRequestSchema,
  ]
);

const desktopGithubPullRequestUpdateBaseSchema = z
  .object({
    contractVersion: z.literal(DesktopGithubPullRequestContractVersion),
    repoFullName: repoFullNameSchema,
    title: z.string().trim().min(1).optional(),
    body: z.string().max(DesktopGithubPullRequestBodyMaxLength).optional(),
    labels: pullRequestLabelSpecListValidator.optional(),
  })
  .strict();

export const desktopGithubPullRequestUpdateRequestSchema =
  desktopGithubPullRequestUpdateBaseSchema.refine(
    (value) =>
      value.title !== undefined ||
      value.body !== undefined ||
      (value.labels !== undefined && value.labels.length > 0),
    "at least one of title, body, or labels is required"
  );

export const desktopGithubPullRequestLabelSyncResultSchema = z.object({
  status: z.enum(PullRequestLabelSyncStatus),
  knownAppliedLabels: z.array(z.string()).optional(),
  createdLabels: z.array(z.string()),
  addedLabels: z.array(z.string()),
  droppedLabels: z.array(z.string()),
});

const desktopGithubPullRequestLabelsSchema = z.object({
  appliedLabels: z.array(z.string()).optional(),
  labelsApplied: z.boolean().optional(),
  droppedLabels: z.array(z.string()).optional(),
  unappliedLabels: z.array(z.string()).optional(),
});

const desktopGithubPullRequestPreflightSuccessSchema = z.object({
  success: z.literal(true),
  contractVersion: z.literal(DesktopGithubPullRequestContractVersion),
  mode: z.literal(DesktopGithubPullRequestSuccessMode.Preflight),
  status: z.literal(DesktopGithubPullRequestStatus.Available),
  repository: z.object({
    fullName: repoFullNameSchema,
    defaultBranch: branchNameSchema.optional(),
  }),
  identity: z.object({
    login: z.string().trim().min(1),
  }),
});

const desktopGithubPullRequestDataSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  headBranch: branchNameSchema.optional(),
  baseBranch: branchNameSchema.optional(),
});

const desktopGithubPullRequestCreateSuccessSchema = z.object({
  success: z.literal(true),
  contractVersion: z.literal(DesktopGithubPullRequestContractVersion),
  mode: z.literal(DesktopGithubPullRequestSuccessMode.Create),
  status: z.union([
    z.literal(DesktopGithubPullRequestStatus.Created),
    z.literal(DesktopGithubPullRequestStatus.Existing),
  ]),
  pullRequest: desktopGithubPullRequestDataSchema,
  labels: desktopGithubPullRequestLabelsSchema.optional(),
});

const desktopGithubPullRequestUpdateSuccessSchema = z.object({
  success: z.literal(true),
  contractVersion: z.literal(DesktopGithubPullRequestContractVersion),
  mode: z.literal(DesktopGithubPullRequestSuccessMode.Update),
  status: z.literal(DesktopGithubPullRequestStatus.Updated),
  pullRequest: desktopGithubPullRequestDataSchema,
  labels: desktopGithubPullRequestLabelsSchema.optional(),
});

export const desktopGithubPullRequestSuccessSchema = z.union([
  desktopGithubPullRequestPreflightSuccessSchema,
  desktopGithubPullRequestCreateSuccessSchema,
  desktopGithubPullRequestUpdateSuccessSchema,
]);

export const desktopGithubPullRequestFailureSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  code: z.enum(DesktopGithubPullRequestErrorCode),
  reason: z.enum(DesktopGithubPullRequestReason),
  denial: z.enum(GitHubAccessDenialReason).optional(),
  stage: z.enum(DesktopGithubPullRequestStage),
  retryable: z.boolean(),
  burnRetryBudget: z.boolean(),
});

export const desktopGithubPullRequestResponseSchema = z.union([
  desktopGithubPullRequestSuccessSchema,
  desktopGithubPullRequestFailureSchema,
]);

export type DesktopGithubPullRequestPreflightRequest = z.infer<
  typeof desktopGithubPullRequestPreflightRequestSchema
>;
export type DesktopGithubPullRequestCreateRequest = z.infer<
  typeof desktopGithubPullRequestCreateRequestSchema
>;
export type DesktopGithubPullRequestRequest = z.infer<
  typeof desktopGithubPullRequestRequestSchema
>;
export type DesktopGithubPullRequestUpdateRequest = z.infer<
  typeof desktopGithubPullRequestUpdateRequestSchema
>;
export type DesktopGithubPullRequestSuccess = z.infer<
  typeof desktopGithubPullRequestSuccessSchema
>;
export type DesktopGithubPullRequestLabels = z.infer<
  typeof desktopGithubPullRequestLabelsSchema
>;
export type DesktopGithubPullRequestFailure = z.infer<
  typeof desktopGithubPullRequestFailureSchema
>;
export type DesktopGithubPullRequestResponse = z.infer<
  typeof desktopGithubPullRequestResponseSchema
>;

export function labelResponseFields(
  requestedLabels: readonly PullRequestLabelSpec[],
  droppedLabels: readonly string[],
  appliedLabels: readonly string[]
): DesktopGithubPullRequestLabels | undefined {
  const dropped =
    droppedLabels.length > 0 ? { droppedLabels: [...droppedLabels] } : {};
  if (requestedLabels.length === 0) {
    return droppedLabels.length > 0 ? dropped : undefined;
  }
  const applied = [...appliedLabels];
  const appliedNames = new Set(applied);
  const unapplied = requestedLabels
    .map((label) => label.name)
    .filter((name) => !appliedNames.has(name));
  return {
    appliedLabels: applied,
    labelsApplied: unapplied.length === 0,
    ...(unapplied.length > 0 ? { unappliedLabels: unapplied } : {}),
    ...dropped,
  };
}
