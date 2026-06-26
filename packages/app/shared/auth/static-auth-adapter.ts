import type { AuthAdapter, AuthSnapshot } from "./auth-adapter";

/**
 * Fixed-state auth adapter for unit tests and Storybook. Proves shared code
 * runs against a non-Clerk auth source (FEA-1510 injection seam) and avoids
 * mocking the auth SDK in consumers.
 */
export type StaticAuthOptions = Partial<AuthSnapshot>;

export function createStaticAuthAdapter(
  options: StaticAuthOptions = {}
): AuthAdapter {
  // Spread so explicit null overrides (e.g. signed-out: orgId: null) are
  // honored rather than swallowed by ?? defaulting.
  const snapshot: AuthSnapshot = {
    isLoaded: true,
    userId: "user_test",
    orgId: "org_test",
    getToken: () => Promise.resolve("test-token"),
    ...options,
  };

  return {
    // Static snapshot: returning the closed-over object satisfies the
    // referential-stability contract without calling any hooks.
    useAuthSnapshot: () => snapshot,
  };
}
