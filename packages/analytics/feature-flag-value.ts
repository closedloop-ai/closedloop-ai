/**
 * The one rule for reading a raw PostHog flag value as enabled/disabled.
 *
 * PostHog returns a `boolean` for a plain flag and the variant `string` for a
 * multivariate one, in that same shape from BOTH the browser SDK (`client.ts`)
 * and posthog-node's whole-assignment read (`feature-flags.ts`). Those two
 * normalizations used to be written independently and had already drifted on
 * the empty-string variant, which is exactly the cross-surface disagreement
 * ISS-8024 exists to remove — so the rule lives here once and both import it.
 *
 * Deliberately dependency-free: `client.ts` is a `"use client"` module on a
 * bundle-sensitive path, so this must not drag in Zod, PostHog, or Next.
 *
 * A VARIANT STRING IS ENABLED, whatever it says. PostHog only sends a variant
 * for a flag the caller is IN; the string names which arm, not whether the gate
 * is open. Only an explicit boolean `false` — or the absence of the key
 * entirely, which never reaches here — is off.
 */
export function isPostHogFlagValueEnabled(value: boolean | string): boolean {
  return typeof value === "string" || value === true;
}

/**
 * ISS-12048: the flags a `$vibe` preview environment pins, as PostHog's own
 * values. Here, beside the enabled rule, so the browser and the server read a
 * pinned value through the same predicate.
 */
export type PinnedFeatureFlags = Readonly<Record<string, boolean | string>>;

/**
 * A pinned flag's verdict. A key the snapshot does not hold is OFF: the
 * snapshot is every flag PostHog answered, so an absent key had no flag behind
 * it in production either.
 */
export function isPinnedFeatureFlagEnabled(
  pinned: PinnedFeatureFlags,
  flag: string
): boolean {
  const value = Object.hasOwn(pinned, flag) ? pinned[flag] : undefined;
  return value !== undefined && isPostHogFlagValueEnabled(value);
}
