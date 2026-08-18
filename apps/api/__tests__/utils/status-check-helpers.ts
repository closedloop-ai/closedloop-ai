import { GitHubProviderResultStatus } from "@repo/github";

/** Build a minimal successful GitHub status-check rollup fixture. */
export function statusRollup(state: string | null = "SUCCESS") {
  return {
    ok: true,
    state,
    checks: [],
    totalCount: 0,
    truncated: false,
  };
}

/**
 * Wrap a rollup fixture in the success arm of `GitHubProviderResult`. The
 * rollup's own `ok: false` failure shape is a value the provider returned
 * successfully, so it belongs inside this wrapper rather than beside it.
 */
export function providerSuccess<T>(value: T) {
  return {
    status: GitHubProviderResultStatus.Success,
    value,
  };
}
