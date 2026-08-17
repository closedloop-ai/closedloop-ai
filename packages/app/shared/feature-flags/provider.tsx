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

/**
 * A stable no-op adapter whose flags are always `false`. Module-level (not
 * created per render) so consuming it keeps a consistent hook identity across
 * renders. Backs {@link useFeatureFlagAdapterOptional} for additive UI that must
 * degrade to "flag off" — rather than throw — when it happens to be mounted
 * outside a provider (e.g. a shared table embedded in Storybook or a mini-table
 * test that never wired the flag port).
 */
const NO_OP_FEATURE_FLAG_ADAPTER: FeatureFlagAdapter = {
  useFeatureFlagEnabled: () => false,
};

/**
 * Like {@link useFeatureFlagAdapter}, but returns a stable always-off adapter
 * instead of throwing when no {@link FeatureFlagAdapterProvider} is mounted. For
 * purely-additive, flag-gated affordances in SHARED components that can render
 * under mount sites lacking the provider — the affordance simply stays off there
 * (its honest default) rather than crashing the whole subtree. Real product
 * surfaces still mount the provider, so the flag resolves normally for them.
 */
export function useFeatureFlagAdapterOptional(): FeatureFlagAdapter {
  return useContext(FeatureFlagAdapterContext) ?? NO_OP_FEATURE_FLAG_ADAPTER;
}
