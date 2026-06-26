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
  /** Returns the current API bearer token, or null when signed out. */
  getToken: () => Promise<string | null>;
};

export type AuthAdapter = {
  /**
   * Hook returning the live auth snapshot. Implementations must follow the
   * rules of hooks and should return a referentially stable snapshot (memoize
   * on the underlying auth state) so consumers can use it in dependency
   * arrays.
   */
  useAuthSnapshot: () => AuthSnapshot;
};
