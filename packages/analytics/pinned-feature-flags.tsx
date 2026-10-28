"use client";

import { createContext, type ReactNode, useContext } from "react";
import {
  isPinnedFeatureFlagEnabled,
  type PinnedFeatureFlags,
} from "./feature-flag-value";

/**
 * ISS-12048: pins the browser's flag reads to a `$vibe` preview environment's
 * production snapshot, the same values the preview's `apps/api` pins its own
 * reads to. The web shell supplies `flags` from its server render only in a
 * preview deployment that stores a snapshot; everywhere else it passes `null`
 * and every read is live.
 */
export function PinnedFeatureFlagsProvider({
  flags,
  children,
}: {
  flags: PinnedFeatureFlags | null;
  children: ReactNode;
}) {
  return (
    <PinnedFeatureFlagsContext.Provider value={flags}>
      {children}
    </PinnedFeatureFlagsContext.Provider>
  );
}

/** The pinned verdict for `flag`, or `undefined` when nothing is pinned. */
export function usePinnedFeatureFlag(flag: string): boolean | undefined {
  const pinned = useContext(PinnedFeatureFlagsContext);
  return pinned ? isPinnedFeatureFlagEnabled(pinned, flag) : undefined;
}

const PinnedFeatureFlagsContext = createContext<PinnedFeatureFlags | null>(
  null
);
