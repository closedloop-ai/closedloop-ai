"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { FeatureFlagAdapter } from "./feature-flag-adapter";

const FeatureFlagAdapterContext = createContext<FeatureFlagAdapter | null>(
  null
);

export function FeatureFlagAdapterProvider({
  adapter,
  children,
}: {
  adapter: FeatureFlagAdapter;
  children: ReactNode;
}) {
  return (
    <FeatureFlagAdapterContext.Provider value={adapter}>
      {children}
    </FeatureFlagAdapterContext.Provider>
  );
}

/**
 * Internal accessor used by the port hooks. Not intended for direct use by
 * feature code — consume `useFeatureFlagEnabled` instead.
 */
export function useFeatureFlagAdapter(): FeatureFlagAdapter {
  const adapter = useContext(FeatureFlagAdapterContext);
  if (adapter) {
    return adapter;
  }
  throw new Error(
    "Feature-flag hooks require a <FeatureFlagAdapterProvider> ancestor. Mount one at the app root with a surface adapter (web: posthogFeatureFlagAdapter in apps/app)."
  );
}
