import type { GitHubIntegrationStatus } from "./github.ts";

/**
 * Resolves the additive GitHub data-connection predicate — an active user OAuth
 * grant OR an active org App installation, either one sufficient — falling back
 * to the legacy App-installation `connected` field for older API/Desktop
 * payloads. `undefined` means UNKNOWN (still loading, or a payload carrying
 * neither field); it never means disconnected.
 *
 * A leaf module so the Desktop MAIN process, which cannot import `@repo/app`,
 * asks the same question the renderer and the web app ask.
 */
export function resolveGitHubDataConnected(
  status: GitHubIntegrationStatus | null | undefined
): boolean | undefined {
  if (status?.githubDataConnection?.connected !== undefined) {
    return status.githubDataConnection.connected;
  }
  return status?.connected;
}
