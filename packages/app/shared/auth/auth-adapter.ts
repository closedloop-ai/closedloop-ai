/**
 * Auth port for the shared app-core layer (FEA-1510).
 *
 * `@repo/app` is surface-agnostic: it never imports Clerk or any other auth
 * SDK. Each shell (web: Clerk via `apps/app`; desktop: keychain session via
 * FEA-1514) supplies an adapter at its composition root through
 * `AuthAdapterProvider`.
 */

export type AuthSnapshot = {
  /** False until the shell's auth state has hydrated. */
  isLoaded: boolean;
  userId: string | null;
  orgId: string | null;
  /**
   * Returns the current API bearer token, or null when signed out.
   *
   * `options.forceRefresh` asks the shell to bypass any client-side token cache
   * (ISS-9701) — see {@link AuthTokenOptions}. An adapter whose token source has
   * no such cache may ignore it; the parameter is optional so an existing
   * zero-argument implementation still satisfies this port.
   */
  getToken: (options?: AuthTokenOptions) => Promise<string | null>;
};

export type AuthAdapter = {
  /**
   * Hook returning the live auth snapshot. Implementations must follow the
   * rules of hooks and should return a referentially stable snapshot (memoize
   * on the underlying auth state) so consumers can use it in dependency
   * arrays.
   */
  useAuthSnapshot: () => AuthSnapshot;
  /**
   * Hook returning a function that resynchronizes the shell after the ACTIVE
   * organization's identity changed — today, only its slug (ISS-8365).
   *
   * Web needs this and shared code cannot do it. `useOrgPathBuilder` builds
   * every org-scoped href from Clerk's active-organization slug
   * (`apps/app/lib/navigation/next-adapter.tsx`), so a renamed organization
   * keeps minting hrefs under the OLD slug until the Clerk organization and
   * session are reloaded — and the current URL still names the old slug too.
   * Both halves are one job, and both reach for things `@repo/app` may not
   * touch: `@clerk/*`, `next/*`, and `/${orgSlug}` path interpolation.
   *
   * OPTIONAL. A shell with no URL-visible organization has nothing to
   * re-anchor and no Clerk object to reload; omitting it correctly reads as
   * "no resynchronization needed" rather than as a missing capability.
   *
   * Implementations MUST resolve even when the underlying reload fails. The
   * caller has already committed the mutation server-side, so a failed refresh
   * may not strand the user on a URL that no longer resolves.
   */
  useOrganizationIdentityResync?: () => (nextOrgSlug: string) => Promise<void>;
};

/**
 * Options for one token read (ISS-9701).
 *
 * Auth SDKs cache the short-lived bearer token they mint, so calling
 * `getToken()` again after the server rejected one hands back the SAME rejected
 * string. `forceRefresh` is how the shared API client asks for a genuinely new
 * one before retrying a 401. It is a request, not a guarantee: a shell whose
 * token source holds no cache (the desktop renderer, which carries an opaque
 * sentinel while the main process holds the real credential) correctly ignores
 * it, and the retry still reaches a fresh credential on that surface because the
 * main-process bridge drops its cached token when the server answers 401.
 */
export type AuthTokenOptions = {
  /** Bypass any client-side token cache and mint a new token. */
  forceRefresh?: boolean;
};
