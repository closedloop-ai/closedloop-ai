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
   * Produced ONLY by the repo-scoped bundled read, never by the shared
   * error classifier — see classifyBundledRepositoryAccessFailure.
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
   * is produced ONLY by the guarded repo-scoped bundled read.
   */
  ProviderRepoForbidden: "provider_repo_forbidden",
  ProviderUnavailable: "provider_unavailable",
} as const;
export type GitHubProviderResultStatus =
  (typeof GitHubProviderResultStatus)[keyof typeof GitHubProviderResultStatus];

/** Credential-specific failures exposed by caller-supplied user-token reads. */
export const GitHubUserTokenProviderResultStatus = {
  CredentialInsufficientScope: "credential_insufficient_scope",
  CredentialUnauthorized: "credential_unauthorized",
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
      status: typeof GitHubUserTokenProviderResultStatus.CredentialUnauthorized;
    };
