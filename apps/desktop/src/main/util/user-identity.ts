/**
 * @file user-identity.ts
 * @description The one pair-equality predicate for a signed-in desktop user.
 *
 * Several lanes carry the same `(user_id, organization_id)` pair — the
 * trace-comment identity resolver that resolves it, the db-host identity
 * publisher that forwards it to the SQLite child, and the session writers that
 * stamp it. They must all agree on what "the identity changed" means, because
 * the pair is the unit: a user id that survives an org switch is still a
 * different identity, and the ISS-6168 backfill guards on the pair for exactly
 * that reason. Keeping the comparison here stops the predicate from being
 * re-derived per lane and quietly drifting to a user-id-only check.
 */

/** A resolved signed-in identity, or `null` when the machine is signed out. */
export type UserIdentityPair = {
  userId: string | null;
  organizationId: string | null;
} | null;

/** Subscribe to a change signal; returns the unsubscribe. */
export type UserIdentityChangeSubscription = (
  listener: () => void
) => () => void;

/** The collaborators an identity change can be observed through. */
export type UserIdentityChangeSources = {
  /** The active-credential store — a key set, rotated (org switch), or cleared. */
  apiKeyStore: { subscribe: UserIdentityChangeSubscription };
  /** The `/me` resolver — the background resolution after a cold start. */
  identityResolver: { subscribe: UserIdentityChangeSubscription };
};

/** True when both sides describe the same signed-in user in the same org. */
export function sameUserIdentity(
  a: UserIdentityPair,
  b: UserIdentityPair
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.userId === b.userId && a.organizationId === b.organizationId;
}

/**
 * ISS-6243 — fan one listener out to BOTH places an identity change is
 * observable, and release both on unsubscribe.
 *
 * It exists as its own unit, with both collaborators REQUIRED, because the
 * composition is the part that silently half-breaks: dropping the resolver arm
 * loses the cold-start `/me` landing (the whole defect), dropping the credential
 * arm loses sign-out and org switch, and either would leave a suite that only
 * tests the two sources separately entirely green. Requiring both here means a
 * caller that drops one fails typecheck rather than production.
 */
export function createUserIdentityChangeSubscription(
  sources: UserIdentityChangeSources
): UserIdentityChangeSubscription {
  return (listener: () => void) => {
    const unsubscribeApiKey = sources.apiKeyStore.subscribe(listener);
    const unsubscribeResolved = sources.identityResolver.subscribe(listener);
    return () => {
      unsubscribeApiKey();
      unsubscribeResolved();
    };
  };
}
