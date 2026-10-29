import {
  DesktopGithubPullRequestErrorCode,
  type DesktopGithubPullRequestFailure,
  DesktopGithubPullRequestReason,
  DesktopGithubPullRequestStage,
} from "@repo/api/src/types/desktop-github-pull-request";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import {
  classifyGitHubProviderError,
  type GitHubOperationProviderFailure,
} from "@repo/github/provider-error-classification";
import { GitHubProviderResultStatus } from "@repo/github/provider-result";
import { z } from "zod";
import { extractGitHubHttpStatus } from "@/lib/github/github-access";

export type DesktopGithubPullRequestServiceFailure =
  DesktopGithubPullRequestFailure & {
    status: number;
    retryAfterSeconds?: number | null;
  };

const WHITESPACE_REGEX = /\s+/g;
const PROVIDER_MESSAGE_MAX_LENGTH = 300;
const githubProviderErrorSchema = z
  .object({
    response: z
      .object({
        data: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const githubProviderErrorDataSchema = z
  .object({
    errors: z
      .array(
        z.object({
          message: z.string(),
        })
      )
      .optional(),
    message: z.string().optional(),
  })
  .passthrough();

export function credentialFailure(
  denial: GitHubAccessDenialReason,
  stage: DesktopGithubPullRequestStage = DesktopGithubPullRequestStage.ApiPreflight
): DesktopGithubPullRequestServiceFailure {
  if (
    denial === GitHubAccessDenialReason.NotConnected ||
    denial === GitHubAccessDenialReason.Revoked
  ) {
    return serviceFailure({
      status: 401,
      code: DesktopGithubPullRequestErrorCode.AuthenticationRequired,
      reason: DesktopGithubPullRequestReason.AuthenticationRequired,
      stage,
      message:
        "GitHub authentication is required for this pull request operation.",
      retryable: false,
      denial,
    });
  }
  if (
    denial === GitHubAccessDenialReason.InsufficientScope ||
    denial === GitHubAccessDenialReason.OrgRestricted ||
    denial === GitHubAccessDenialReason.NoInstallation
  ) {
    return serviceFailure({
      status: 403,
      code: DesktopGithubPullRequestErrorCode.AuthorizationDenied,
      reason: DesktopGithubPullRequestReason.AuthorizationDenied,
      stage,
      message:
        "GitHub authorization does not allow this pull request operation.",
      retryable: false,
      denial,
    });
  }
  if (denial === GitHubAccessDenialReason.RateLimited) {
    return serviceFailure({
      status: 429,
      code: DesktopGithubPullRequestErrorCode.ProviderRateLimited,
      reason: DesktopGithubPullRequestReason.ProviderRateLimited,
      stage,
      message: "GitHub is rate limited for pull request creation.",
      retryable: true,
      denial,
    });
  }
  return serviceFailure({
    status: 503,
    code: DesktopGithubPullRequestErrorCode.TransientUnavailable,
    reason: DesktopGithubPullRequestReason.TransientUnavailable,
    stage,
    message: "GitHub credentials are temporarily unavailable.",
    retryable: true,
    denial,
  });
}

export function providerFailure(
  error: unknown,
  stage: DesktopGithubPullRequestStage,
  now: Date
): DesktopGithubPullRequestServiceFailure {
  const status = extractGitHubHttpStatus(error);
  if (status === 401) {
    return serviceFailure({
      status: 401,
      code: DesktopGithubPullRequestErrorCode.AuthenticationRequired,
      reason: DesktopGithubPullRequestReason.AuthenticationRequired,
      stage,
      message: "GitHub rejected the authenticated user token.",
      retryable: false,
    });
  }
  if (status === 404) {
    if (stage === DesktopGithubPullRequestStage.ApiUpdate) {
      return serviceFailure({
        status: 404,
        code: DesktopGithubPullRequestErrorCode.PullRequestUnavailable,
        reason: DesktopGithubPullRequestReason.PullRequestUnavailable,
        stage,
        message:
          "GitHub pull request is unavailable to the authenticated user.",
        retryable: false,
      });
    }
    return serviceFailure({
      status: 404,
      code: DesktopGithubPullRequestErrorCode.RepositoryUnavailable,
      reason: DesktopGithubPullRequestReason.RepositoryUnavailable,
      stage,
      message: "GitHub repository is unavailable to the authenticated user.",
      retryable: false,
    });
  }
  if (status === 409) {
    if (stage === DesktopGithubPullRequestStage.ApiCreate) {
      return serviceFailure({
        status: 409,
        code: DesktopGithubPullRequestErrorCode.PullRequestAlreadyExists,
        reason: DesktopGithubPullRequestReason.PullRequestAlreadyExists,
        stage,
        message:
          "GitHub reported an existing or ambiguous pull request for this branch.",
        retryable: false,
      });
    }
    return serviceFailure({
      status: 409,
      code: DesktopGithubPullRequestErrorCode.ProviderRejected,
      reason: DesktopGithubPullRequestReason.ProviderRejected,
      stage,
      message: "GitHub returned ambiguous pull request state.",
      retryable: false,
    });
  }
  if (status === 422) {
    const providerMessage = sanitizedProviderMessage(error);
    if (stage === DesktopGithubPullRequestStage.ApiCreate) {
      return serviceFailure({
        status: 409,
        code: DesktopGithubPullRequestErrorCode.PullRequestAlreadyExists,
        reason: DesktopGithubPullRequestReason.PullRequestAlreadyExists,
        stage,
        message: providerMessage
          ? `GitHub rejected pull request creation: ${providerMessage}`
          : "GitHub reported that this pull request already exists or cannot be created from the pushed branch.",
        retryable: false,
      });
    }
    return serviceFailure({
      status: 409,
      code: DesktopGithubPullRequestErrorCode.ProviderRejected,
      reason: DesktopGithubPullRequestReason.ProviderRejected,
      stage,
      message: providerMessage
        ? `GitHub rejected the pull request request: ${providerMessage}`
        : "GitHub rejected the pull request request.",
      retryable: false,
    });
  }

  const classification = classifyGitHubProviderError(error, now.getTime());
  if (classification.status === GitHubProviderResultStatus.ProviderRateLimit) {
    return providerRateLimitFailure(classification, stage);
  }
  if (
    classification.status ===
    GitHubProviderResultStatus.ProviderPermissionFiltered
  ) {
    return serviceFailure({
      status: 403,
      code: DesktopGithubPullRequestErrorCode.AuthorizationDenied,
      reason: DesktopGithubPullRequestReason.AuthorizationDenied,
      stage,
      message:
        "GitHub authorization does not allow creating this pull request.",
      retryable: false,
    });
  }
  return serviceFailure({
    status: 503,
    code: DesktopGithubPullRequestErrorCode.TransientUnavailable,
    reason: DesktopGithubPullRequestReason.TransientUnavailable,
    stage,
    message: "GitHub pull request service is temporarily unavailable.",
    retryable: true,
  });
}

export function serviceFailure(input: {
  status: number;
  code: DesktopGithubPullRequestErrorCode;
  reason: DesktopGithubPullRequestReason;
  stage: DesktopGithubPullRequestStage;
  message: string;
  retryable: boolean;
  denial?: GitHubAccessDenialReason;
  retryAfterSeconds?: number | null;
}): DesktopGithubPullRequestServiceFailure {
  return {
    success: false,
    error: input.message,
    code: input.code,
    reason: input.reason,
    stage: input.stage,
    retryable: input.retryable,
    burnRetryBudget: false,
    status: input.status,
    ...(input.denial === undefined ? {} : { denial: input.denial }),
    ...(input.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: input.retryAfterSeconds }),
  };
}

function providerRateLimitFailure(
  classification: Extract<
    GitHubOperationProviderFailure,
    { status: typeof GitHubProviderResultStatus.ProviderRateLimit }
  >,
  stage: DesktopGithubPullRequestStage
): DesktopGithubPullRequestServiceFailure {
  return serviceFailure({
    status: 429,
    code: DesktopGithubPullRequestErrorCode.ProviderRateLimited,
    reason: DesktopGithubPullRequestReason.ProviderRateLimited,
    stage,
    message: "GitHub rate limited pull request creation.",
    retryable: true,
    retryAfterSeconds: classification.retryAfterSeconds,
  });
}

function sanitizedProviderMessage(error: unknown): string | null {
  const parsed = githubProviderErrorSchema.safeParse(error);
  if (!parsed.success) {
    return null;
  }
  const data = githubProviderErrorDataSchema.safeParse(
    parsed.data.response?.data
  );
  if (!data.success) {
    return null;
  }
  const messages = [
    ...(data.data.errors?.map(({ message }) => message) ?? []),
    data.data.message,
  ];
  for (const message of messages) {
    if (typeof message !== "string") {
      continue;
    }
    const sanitized = sanitizeProviderText(message);
    if (sanitized) {
      return sanitized;
    }
  }
  return null;
}

function sanitizeProviderText(message: string): string | null {
  const normalized = message
    .split("")
    .map((char) => (isControlCharacter(char) ? " " : char))
    .join("")
    .replace(WHITESPACE_REGEX, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= PROVIDER_MESSAGE_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, PROVIDER_MESSAGE_MAX_LENGTH - 3).trimEnd()}...`;
}

function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 32 || code === 127;
}
