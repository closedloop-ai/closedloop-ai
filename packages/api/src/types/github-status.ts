/** GitHub pull request lifecycle states shared across API clients and providers. */
export const GitHubPRState = {
  Open: "OPEN",
  Merged: "MERGED",
  Closed: "CLOSED",
} as const;
export type GitHubPRState = (typeof GitHubPRState)[keyof typeof GitHubPRState];

/** Exact reason taxonomy for unavailable GitHub status-check rollup reads. */
export const StatusCheckRollupFailureReason = {
  InvalidInput: "invalid_input",
  RateLimited: "rate_limited",
  PermissionDenied: "permission_denied",
  GraphqlError: "graphql_error",
} as const;
export type StatusCheckRollupFailureReason =
  (typeof StatusCheckRollupFailureReason)[keyof typeof StatusCheckRollupFailureReason];

/** GitHub aggregate statusCheckRollup states preserved at the provider edge. */
export type StatusCheckRollupState =
  | "SUCCESS"
  | "FAILURE"
  | "ERROR"
  | "PENDING"
  | "EXPECTED";

/**
 * Status carried on the `?github=` query param when the GitHub OAuth connect
 * flow bounces back to an in-app surface (e.g. the branches list/detail pages
 * or settings). The callback writer sets these values and the return-notice
 * banners read them; keep this the single source of truth so the writer and
 * every consumer cannot drift.
 */
export const GitHubConnectReturnStatus = {
  Connected: "connected",
  Error: "error",
} as const;
export type GitHubConnectReturnStatus =
  (typeof GitHubConnectReturnStatus)[keyof typeof GitHubConnectReturnStatus];
