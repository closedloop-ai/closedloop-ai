"use client";

import { createContext, type ReactNode, useContext, useEffect } from "react";
import type { AuthAdapter } from "./auth-adapter";
import { observeSignedInIdentity } from "./signed-in-identity";

const AuthAdapterContext = createContext<AuthAdapter | null>(null);

export function AuthAdapterProvider({
  adapter,
  children,
}: {
  adapter: AuthAdapter;
  children?: ReactNode;
}) {
  return (
    <AuthAdapterContext.Provider value={adapter}>
      <SignedInIdentityObserver adapter={adapter} />
      {children}
    </AuthAdapterContext.Provider>
  );
}

/**
 * Publishes every settled identity to {@link observeSignedInIdentity}, so a
 * module-scope cache can discard one account's data when another signs in
 * (PLN-1915 Step 8).
 *
 * A SIBLING of `children` rather than a hook in the provider body — which is a
 * separation, NOT a re-render optimization. `children` arrives as a prop
 * element, so its identity survives a re-render the provider triggers itself and
 * React bails out of that subtree either way. What the split buys is that the
 * provider's body stays a plain context wrapper with no auth subscription of its
 * own, and the publish is one named unit whose effect can be exercised without a
 * tree beneath it.
 *
 * It lives at the PROVIDER, not in each cache's own consumer, because a
 * module-scope cache outlives the tree that filled it: the surface that
 * populated it may be long unmounted when the identity moves, and asking every
 * consumer to remember the reset is how one of them forgets.
 */
function SignedInIdentityObserver({
  adapter,
}: Readonly<{ adapter: AuthAdapter }>) {
  const { isLoaded, userId, orgId } = adapter.useAuthSnapshot();

  useEffect(() => {
    // Only a LOADED snapshot is an identity. A null userId while the shell is
    // still hydrating is not a sign-out, and publishing it would report a
    // change on every page load.
    if (isLoaded) {
      observeSignedInIdentity({ organizationId: orgId, userId });
    }
  }, [isLoaded, userId, orgId]);

  return null;
}

/**
 * Internal accessor used by the port hooks. Not intended for direct use by
 * feature code — consume `useAuthSnapshot` instead.
 */
export function useAuthAdapter(): AuthAdapter {
  const adapter = useContext(AuthAdapterContext);
  if (adapter) {
    return adapter;
  }
  throw new Error(
    "Auth hooks require an <AuthAdapterProvider> ancestor. Mount one at the app root with a surface adapter (web: clerkAuthAdapter in apps/app)."
  );
}

/**
 * Non-throwing accessor: the injected adapter when a provider is mounted, else
 * `null`. For shared machinery that can degrade gracefully without an identity
 * (e.g. namespacing a persisted view by user when signed in, falling back to an
 * un-namespaced key when no auth context exists — tests, Storybook). Feature
 * code that genuinely needs auth should keep using `useAuthSnapshot`, which
 * throws so a missing provider is caught early.
 */
export function useOptionalAuthAdapter(): AuthAdapter | null {
  return useContext(AuthAdapterContext);
}
