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
  /**
   * Hook returning whether the named flag has actually been RESOLVED yet, as
   * distinct from resolving to `false`.
   *
   * {@link FeatureFlagAdapter.useFeatureFlagEnabled} collapses "not loaded" into
   * `false`, which is the right default for rendering but wrong for a data read:
   * a surface that keys its request off a flag would issue the flag-off request
   * first and refetch once the flag lands, so an enabled user still pays the
   * cost the flag exists to avoid (wongk, FEA-1626).
   *
   * OPTIONAL. An adapter whose flags resolve synchronously — the desktop shell's
   * Labs config, the static test adapter — has no unresolved state, so omitting
   * it correctly reads as "always resolved". Only an asynchronous provider
   * (PostHog on web) needs to implement it.
   */
  useFeatureFlagResolved?: (key: string) => boolean;
};
