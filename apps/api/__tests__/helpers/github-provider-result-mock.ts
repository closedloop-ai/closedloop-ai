import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
} from "@repo/github";

const GITHUB_PROVIDER_RESULT_STATUSES = new Set<string>(
  Object.values(GitHubProviderResultStatus)
);

/**
 * Wrap legacy GitHub test mock values in the provider-result contract used by
 * production helpers. Existing provider results pass through unchanged.
 */
export function toGitHubProviderResultMock<T>(
  value: T | GitHubProviderResult<T> | null
): GitHubProviderResult<T> {
  if (isGitHubProviderResult(value)) {
    return value;
  }
  return value === null
    ? { status: GitHubProviderResultStatus.ProviderUnavailable }
    : { status: GitHubProviderResultStatus.Success, value };
}

/**
 * Wrap values that are valid successful provider responses even when `null`.
 */
export function toSuccessfulGitHubProviderResultMock<T>(
  value: T | GitHubProviderResult<T>
): GitHubProviderResult<T> {
  if (isGitHubProviderResult(value)) {
    return value;
  }
  return { status: GitHubProviderResultStatus.Success, value };
}

function isGitHubProviderResult<T>(
  value: T | GitHubProviderResult<T> | null
): value is GitHubProviderResult<T> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const status = Reflect.get(value, "status");
  return (
    typeof status === "string" && GITHUB_PROVIDER_RESULT_STATUSES.has(status)
  );
}
