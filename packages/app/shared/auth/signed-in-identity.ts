/**
 * WHEN the signed-in identity changes, for module-scope caches that outlive a
 * React tree (PLN-1915 Step 8).
 *
 * A cache kept at module scope survives a sign-out, a sign-in as somebody else,
 * and a workspace switch, because none of those unloads the bundle. Anything
 * retained across that boundary is one account's data answering another
 * account's question, so the retainer needs a moment to let go — and it must be
 * a moment the retainer does not have to be mounted to observe.
 *
 * Deliberately narrow. It carries NO identity to its listeners and no payload:
 * a listener is told only that the identity moved, so this can never become the
 * channel through which one account's data reaches another's surface. The only
 * producer is {@link observeSignedInIdentity}, called from the auth provider
 * that already observes the shell's identity on both surfaces.
 */

export type SignedInIdentity = {
  userId: string | null;
  organizationId: string | null;
};

type SignedInIdentityChangeListener = () => void;

const identityChangeListeners = new Set<SignedInIdentityChangeListener>();

/**
 * The last identity actually observed, or null before the shell has settled one.
 * The FIRST settled observation seeds this without notifying: a page that has
 * just loaded has not changed identity, and firing there would clear caches
 * that legitimately settled moments earlier in the same session.
 */
let observedIdentity: SignedInIdentity | null = null;

export function subscribeToSignedInIdentityChange(
  onIdentityChange: SignedInIdentityChangeListener
): () => void {
  identityChangeListeners.add(onIdentityChange);
  return () => {
    identityChangeListeners.delete(onIdentityChange);
  };
}

/**
 * Record a SETTLED identity. Notifies only when it differs from the previous
 * settled one, so an unchanged re-render costs nothing and a listener cannot be
 * asked to discard state that is still current.
 *
 * Callers pass only loaded snapshots: a `null` userId observed while the shell
 * is still hydrating is not a sign-out, and treating it as one would clear a
 * cache on every page load.
 */
export function observeSignedInIdentity(identity: SignedInIdentity): void {
  const previous = observedIdentity;
  if (previous !== null && isSameSignedInIdentity(previous, identity)) {
    return;
  }
  observedIdentity = identity;
  if (previous === null) {
    return;
  }
  for (const onIdentityChange of identityChangeListeners) {
    onIdentityChange();
  }
}

export function isSameSignedInIdentity(
  left: SignedInIdentity,
  right: SignedInIdentity
): boolean {
  return (
    left.userId === right.userId && left.organizationId === right.organizationId
  );
}

/**
 * Test-only: forget the observed identity so a case starts from an unseeded
 * module, exactly as a fresh page load would. Production has no reason to call
 * it — the identity a shell last settled is a fact, not a cache.
 */
export function resetObservedSignedInIdentityForTests(): void {
  observedIdentity = null;
}

/**
 * Track one piece of async work against the signed-in identity: `isCurrent()`
 * turns false, permanently, the first time the identity changes after the
 * call. Built on {@link subscribeToSignedInIdentityChange}, so it carries no
 * identity of its own and outlives the component that started the work. The
 * caller disposes it once the work settles.
 */
export function watchSignedInIdentity(): {
  dispose: () => void;
  isCurrent: () => boolean;
} {
  let current = true;
  const dispose = subscribeToSignedInIdentityChange(() => {
    current = false;
    dispose();
  });
  return { dispose, isCurrent: () => current };
}
