"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { AuthAdapter } from "./auth-adapter";

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
      {children}
    </AuthAdapterContext.Provider>
  );
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
