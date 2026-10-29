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
   * cost the flag exists to avoid (whitlockk, FEA-1626).
   *
   * OPTIONAL. An adapter reading no asynchronous source — the static adapter
   * (`createStaticFeatureFlagAdapter`), the no-op adapter behind
   * `useFeatureFlagAdapterOptional` — has no unresolved state, so omitting it
   * correctly reads as "always resolved".
   *
   * Each shell's real flag SOURCE implements it: web resolves PostHog through
   * the client SDK, desktop the signed-in account's PostHog assignment over the
   * IPC bridge, which is pending until it settles. So the unresolved window is
   * real on desktop too — but only BELOW `App`, because the desktop composition
   * root mounts the static all-off adapter above it
   * (`desktop-app-core-provider.tsx`), and every flag in that outer slice reads
   * resolved-and-false however the key is set.
   */
  useFeatureFlagResolved?: (key: string) => boolean;
  /**
   * ISS-12048: hook returning the flag's real value, with no Dev Mode override
   * and no customer-view suppression applied, or `undefined` while it is not
   * known. The Dev Tools overlay shows it beside each flag. It never counts as
   * a read of the flag, so it does not add the key to the page's checked list.
   *
   * OPTIONAL: an adapter without it shows no real value.
   */
  useFeatureFlagProductionValue?: (key: string) => boolean | undefined;
};
