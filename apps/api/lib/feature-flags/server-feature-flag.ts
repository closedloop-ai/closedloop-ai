/**
 * ISS-7778: what a server-evaluated PostHog flag's ENABLED state actually does.
 *
 * Nothing in a flag key, its type, or its call site used to distinguish a flag
 * whose enabled state ADMITS a capability from one whose enabled state IMPOSES a
 * constraint. Both are `boolean`, both read through the same helper, and both
 * look identical to anything that wants to suppress flags in bulk — so a single
 * blanket suppression would turn `desktop-managed-pop-enforcement` off and start
 * ACCEPTING failed proof-of-possession, with no type, test, or review step able
 * to see it happen.
 *
 * The distinction is declared HERE, at each flag's definition, and carried by
 * the value itself rather than recovered later from a list. A list is the
 * failure mode this exists to remove: it is maintained somewhere else, it
 * defaults, and a new enforcement flag added a year from now is silently absent
 * from it.
 */
export const ServerFeatureFlagKind = {
  /**
   * The flag's ENABLED state admits a capability. Withholding it can only ever
   * narrow what is reachable, so a blanket suppression is safe.
   */
  Grant: "grant",
  /**
   * The flag's ENABLED state imposes or tightens a constraint — a rejection, an
   * enforcement, a required signature. Withholding it REMOVES that constraint,
   * so a blanket suppression can only ever weaken the system.
   */
  Restriction: "restriction",
} as const;
export type ServerFeatureFlagKind =
  (typeof ServerFeatureFlagKind)[keyof typeof ServerFeatureFlagKind];

/** A server-evaluated PostHog flag key together with what enabling it does. */
export type ServerFeatureFlag<Key extends string = string> = {
  readonly key: Key;
  readonly kind: ServerFeatureFlagKind;
};

/** A {@link ServerFeatureFlag} statically known to be a grant. */
export type GrantFeatureFlag<Key extends string = string> = {
  readonly key: Key;
  readonly kind: typeof ServerFeatureFlagKind.Grant;
};

/** A {@link ServerFeatureFlag} statically known to be a restriction. */
export type RestrictionFeatureFlag<Key extends string = string> = {
  readonly key: Key;
  readonly kind: typeof ServerFeatureFlagKind.Restriction;
};

/**
 * Declares a flag whose enabled state admits a capability.
 *
 * Returns the narrow {@link GrantFeatureFlag} rather than the wide
 * {@link ServerFeatureFlag} so a grant — and only a grant — can be handed to
 * `suppressGrants`.
 */
export function defineGrantFlag<Key extends string>(
  key: Key
): GrantFeatureFlag<Key> {
  return { key, kind: ServerFeatureFlagKind.Grant };
}

/**
 * Declares a flag whose enabled state imposes a constraint.
 *
 * The returned type is what makes suppressing enforcement unrepresentable:
 * `suppressGrants` accepts {@link GrantFeatureFlag} only, and a
 * {@link RestrictionFeatureFlag} is not assignable to it.
 */
export function defineRestrictionFlag<Key extends string>(
  key: Key
): RestrictionFeatureFlag<Key> {
  return { key, kind: ServerFeatureFlagKind.Restriction };
}
