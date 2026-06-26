/**
 * Feature-flag port for the shared app-core layer (FEA-1510).
 *
 * `@repo/app` is surface-agnostic: it never imports the analytics SDK
 * (`@repo/analytics/client` pulls in PostHog, Next, `server-only`, and
 * `@repo/auth` — all forbidden here). Each shell supplies an adapter at its
 * composition root through `FeatureFlagAdapterProvider`: the web shell wraps
 * PostHog (`apps/app`); the desktop shell mounts its own (FEA-1514).
 */

export type FeatureFlagAdapter = {
  /**
   * Hook returning whether the named flag is enabled. Implementations must
   * follow the rules of hooks. An unknown flag resolves to `false`.
   */
  useFeatureFlagEnabled: (key: string) => boolean;
};
