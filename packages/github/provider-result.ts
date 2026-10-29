/** Stable status vocabulary for GitHub errors-as-values read contracts. */
export const GitHubProviderResultStatus = {
  Success: "success",
  ProviderRateLimit: "provider_rate_limit",
  ProviderPermissionFiltered: "provider_permission_filtered",
  /**
   * ISS-5093: the target repository itself is unreachable with this credential
   * — GitHub cloaks a private repo it cannot show you as NOT_FOUND, so "gone"
   * and "never visible to you" are one condition. Distinct from
   * ProviderUnavailable, which is a transient outage worth retrying: this one
   * is a property of the (credential, repo) pair and is worth remembering.
   * Produced ONLY by a repo-scoped GraphQL read (the paged bundled read and the
   * by-number self-heal read), never by the shared error classifier — see
   * classifyRepositoryAccessFailure.
   */
  ProviderRepoNotFound: "provider_repo_not_found",
  /**
   * ISS-5093: the repository resolved as FORBIDDEN for this credential.
   *
   * Deliberately NOT `ProviderPermissionFiltered`. That status is also produced
   * by the generic HTTP-403 fall-through, which covers credential-level denials
   * (SAML enforcement, IP allowlist, OAuth App restriction) and 403s on a later
   * page of a read whose first page already proved the repo reachable. Folding
   * those into a repo-level verdict would mint per-repo denials against a
   * healthy credential across the whole sweep. Like ProviderRepoNotFound, this
   * is produced ONLY by a guarded repo-scoped GraphQL read.
   */
  ProviderRepoForbidden: "provider_repo_forbidden",
  /** The requested pull request is proven absent from a reachable repository. */
  ProviderPullRequestNotFound: "provider_pull_request_not_found",
  /** The GitHub App installation no longer exists at client-acquisition time. */
  ProviderInstallationNotFound: "provider_installation_not_found",
  /** The selected provider credential is rejected as unauthorized. */
  CredentialUnauthorized: "credential_unauthorized",
  ProviderUnavailable: "provider_unavailable",
} as const;
export type GitHubProviderResultStatus =
  (typeof GitHubProviderResultStatus)[keyof typeof GitHubProviderResultStatus];

/** Materialization-only terminal failures outside the shared legacy contract. */
export const GitHubOperationProviderResultStatus = {
  InvalidResponse: "provider_invalid_response",
} as const;
export type GitHubOperationProviderResultStatus =
  (typeof GitHubOperationProviderResultStatus)[keyof typeof GitHubOperationProviderResultStatus];

/** Credential-specific failures exposed by caller-supplied user-token reads. */
export const GitHubUserTokenProviderResultStatus = {
  CredentialInsufficientScope: "credential_insufficient_scope",
  CredentialUnauthorized: GitHubProviderResultStatus.CredentialUnauthorized,
} as const;
export type GitHubUserTokenProviderResultStatus =
  (typeof GitHubUserTokenProviderResultStatus)[keyof typeof GitHubUserTokenProviderResultStatus];

/** Credential-neutral GitHub read result with bounded retry metadata. */
export type GitHubProviderResult<T> =
  | { status: typeof GitHubProviderResultStatus.Success; value: T }
  | {
      status: typeof GitHubProviderResultStatus.ProviderRateLimit;
      retryAfterSeconds: number | null;
    }
  | {
      status: typeof GitHubProviderResultStatus.ProviderPermissionFiltered;
    }
  | { status: typeof GitHubProviderResultStatus.ProviderRepoNotFound }
  | { status: typeof GitHubProviderResultStatus.ProviderRepoForbidden }
  | { status: typeof GitHubProviderResultStatus.ProviderUnavailable };

/** User-token read result preserving authorization and scope failures. */
export type GitHubUserTokenProviderResult<T> =
  | GitHubProviderResult<T>
  | {
      status: typeof GitHubUserTokenProviderResultStatus.CredentialInsufficientScope;
    }
  | {
      status: typeof GitHubProviderResultStatus.CredentialUnauthorized;
    };

/** Provider stage retained when acquisition and read failures share statuses. */
export const GitHubProviderFailureStage = {
  InstallationClientAcquisition: "installation_client_acquisition",
  PullRequestRead: "pull_request_read",
  RepositoryAccessProbe: "repository_access_probe",
} as const;
export type GitHubProviderFailureStage =
  (typeof GitHubProviderFailureStage)[keyof typeof GitHubProviderFailureStage];
