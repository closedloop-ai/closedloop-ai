import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
} from "@repo/github";
import { getInstallationOctokit } from "@repo/github/installation-auth";
import { toGitHubProviderFailure } from "@repo/github/provider-error-classification";
import type { Octokit } from "@repo/github/user-token-auth";
import { log } from "@repo/observability/log";

/**
 * Acquiring an installation client is a network call — the GitHub App token
 * endpoint can be slow, rate-limited, or refuse a suspended installation — so
 * it fails as often as the reads it precedes. Every caller needs that failure
 * classified the same way the read's own failures are, which is why this
 * module is the single place that catches it.
 *
 * Any caller that reports failure as a value — which is nearly all of
 * `apps/api` — uses these helpers rather than calling `getInstallationOctokit`
 * and catching, because a bare mint at such a call site is an unguarded throw
 * escaping into an errors-as-values contract. A caller that genuinely signals
 * failure by throwing (`authorizeAdditionalRepos`) may mint directly.
 */

/** Acquire an installation client as a value rather than as a throw. */
export async function acquireInstallationClient(
  installationId: string
): Promise<GitHubProviderResult<Octokit>> {
  try {
    return {
      status: GitHubProviderResultStatus.Success,
      value: await getInstallationOctokit(installationId),
    };
  } catch (error) {
    const failure = toGitHubProviderFailure(error);
    // Logged here because callers receive the classified result and can no
    // longer tell a failed acquisition from a failed read — losing that
    // distinction would make "our App credentials are broken" and "GitHub is
    // throttling reads" look identical in triage.
    log.warn("[github/installation-client] Client acquisition failed", {
      installationId,
      status: failure.status,
      error,
    });
    return failure;
  }
}

/** The failure arms every provider-result family shares. */
type InstallationAcquisitionFailure = Exclude<
  GitHubProviderResult<never>,
  { status: typeof GitHubProviderResultStatus.Success }
>;

/**
 * Run a provider read with a freshly acquired installation client, reporting a
 * failed acquisition as the same provider failure the read itself would
 * produce. `read` runs outside the catch, so a defect inside it surfaces
 * instead of being misreported as a provider outage.
 *
 * `read` is generic over its result so both provider-result families work: the
 * user-token family adds credential arms on top of the shared failure arms
 * returned here, and callers narrow on `status` either way.
 */
export async function readWithInstallationClient<TResult>(
  installationId: string,
  read: (octokit: Octokit) => Promise<TResult>
): Promise<TResult | InstallationAcquisitionFailure> {
  const acquired = await acquireInstallationClient(installationId);
  if (acquired.status !== GitHubProviderResultStatus.Success) {
    return acquired;
  }
  return await read(acquired.value);
}
