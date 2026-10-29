import type { GitHubChangedFile } from "@repo/github";
import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
} from "@repo/github/provider-result";

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

/**
 * ISS-6127 moved the compare helper's success value from a bare
 * `GitHubChangedFile[]` to `{ files, capped }`. `toGitHubProviderResultMock`
 * passes its argument through verbatim, so a mock that still resolves a bare
 * array leaves `compared.files` undefined and `prepareFileChanges` throws.
 */
export function comparedFilesMock(files: GitHubChangedFile[] = []) {
  return { files, capped: false };
}

/** One modified file, for the standalone late-success race fixtures. */
export const SINGLE_FILE_COMPARE_MOCK = comparedFilesMock([
  {
    filename: "src/standalone-success.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ standalone success",
  },
]);
