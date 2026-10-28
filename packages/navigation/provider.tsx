"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { NavigationAdapter } from "./navigation-adapter";

const NavigationAdapterContext = createContext<NavigationAdapter | null>(null);

export function NavigationProvider({
  adapter,
  children,
}: {
  adapter: NavigationAdapter;
  children: ReactNode;
}) {
  return (
    <NavigationAdapterContext.Provider value={adapter}>
      {children}
    </NavigationAdapterContext.Provider>
  );
}

/**
 * Internal accessor used by the port hooks and `Link`. Not intended for
 * direct use by feature code — consume the typed hooks instead.
 */
export function useNavigationAdapter(): NavigationAdapter {
  const adapter = useContext(NavigationAdapterContext);
  if (adapter) {
    return adapter;
  }
  throw new Error(
    "Navigation hooks require a <NavigationProvider> ancestor. Mount one at the app root with a surface adapter (web: nextNavigationAdapter)."
  );
}

/**
 * Like {@link useNavigationAdapter}, but resolves to `null` (never throws) when
 * no `NavigationProvider` is mounted.
 *
 * For a SHARED component that reads the route but also renders under mount
 * sites with no router — the desktop `PacksView` mount guard renders its whole
 * tree provider-free and asserts it does not throw (FEA-4159: a hard-throwing
 * hook there is a blank application window, not a failed subtree). Same posture
 * as `useFeatureFlagEnabledOptional` in `@repo/app`.
 */
export function useNavigationAdapterOptional(): NavigationAdapter | null {
  return useContext(NavigationAdapterContext);
}
