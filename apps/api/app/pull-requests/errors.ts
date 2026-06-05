/**
 * Error thrown when a pull request is not found or doesn't belong to the user's organization.
 * Used for consistent error handling across pull request rating operations.
 */
export class PullRequestNotFoundError extends Error {
  readonly status = 404;
  constructor(pullRequestId: string) {
    super(`Pull request not found: ${pullRequestId}`);
    this.name = "PullRequestNotFoundError";
  }
}
