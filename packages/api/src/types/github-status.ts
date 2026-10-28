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

/**
 * Error codes carried on the `?code=` query param whenever the GitHub OAuth
 * connect flow bounces back with `?github=error`. The callback writer sets
 * these and the Settings toast reads them, so this sits beside
 * `GitHubConnectReturnStatus` — its client/server owner — rather than in a
 * server-only utility a bundle-sensitive client would have to reach into.
 *
 * Keep it an allowlist: the redirect builder puts the code straight into a URL,
 * and free-form error text there is an open-redirect vector.
 */
export const GITHUB_ERROR_CODES = {
  NOT_AUTHENTICATED: "not_authenticated",
  NOT_CONFIGURED: "not_configured",
  MISSING_PARAMS: "missing_params",
  INVALID_STATE: "invalid_state",
  CONNECTION_FAILED: "connection_failed",
  OAUTH_FAILED: "oauth_failed",
} as const;
export type GitHubErrorCode =
  (typeof GITHUB_ERROR_CODES)[keyof typeof GITHUB_ERROR_CODES];
