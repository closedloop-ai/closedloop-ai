import {
  type GitHubIntegrationStatus,
  GitHubOAuthRequiredReason,
} from "@repo/api/src/types/github";

export const GitHubConnectMode = {
  Authorize: "authorize",
  Install: "install",
} as const;
export type GitHubConnectMode =
  (typeof GitHubConnectMode)[keyof typeof GitHubConnectMode];

/**
 * Chooses the GitHub connect flow for Insights surfaces. Fresh orgs without an
 * App installation must enter the install flow; existing user-grant recovery
 * states must enter the standard authorize/reconsent flow.
 */
export function resolveGitHubConnectMode(
  status: GitHubIntegrationStatus | null | undefined
): GitHubConnectMode {
  const reasons = status?.githubDataConnection?.oauthRequiredReasons;
  if (reasons) {
    if (hasUserGrantRecoveryReason(reasons)) {
      return GitHubConnectMode.Authorize;
    }
    if (reasons.includes(GitHubOAuthRequiredReason.NoAppInstallation)) {
      return GitHubConnectMode.Install;
    }
    return GitHubConnectMode.Authorize;
  }
  if (status?.connected === false) {
    return GitHubConnectMode.Install;
  }
  return GitHubConnectMode.Authorize;
}

/**
 * Resolves the additive GitHub data-connection predicate, falling back to the
 * legacy App-installation `connected` field for older API/Desktop payloads.
 */
export function resolveGitHubDataConnected(
  status: GitHubIntegrationStatus | null | undefined
): boolean | undefined {
  if (status?.githubDataConnection?.connected !== undefined) {
    return status.githubDataConnection.connected;
  }
  return status?.connected;
}

function hasUserGrantRecoveryReason(
  reasons: readonly GitHubOAuthRequiredReason[]
): boolean {
  return reasons.some(
    (reason) =>
      reason === GitHubOAuthRequiredReason.CredentialExpired ||
      reason === GitHubOAuthRequiredReason.CredentialRevoked ||
      reason === GitHubOAuthRequiredReason.CredentialInsufficientScope ||
      reason === GitHubOAuthRequiredReason.ReconsentRequired
  );
}
