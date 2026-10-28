/**
 * Read the HTTP status off an Octokit/fetch rejection.
 *
 * Callers branch on the status to tell a definitive answer (403/404) from an
 * infrastructure failure (5xx, rate limit, network), so a second private copy
 * of this predicate is exactly the drift this module exists to prevent.
 */
export function extractGitHubErrorStatus(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  return null;
}
