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
