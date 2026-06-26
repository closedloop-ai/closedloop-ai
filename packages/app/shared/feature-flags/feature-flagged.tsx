"use client";

import { type ReactNode, useEffect, useState } from "react";
import { useFeatureFlagEnabled } from "./use-feature-flag-enabled";

type FeatureFlaggedProps = {
  flag: string;
  children: ReactNode;
};

/**
 * Renders `children` only when the named feature flag is enabled.
 * Surface-agnostic (FEA-1510): resolves the flag through the injected
 * feature-flag adapter (which requires a `FeatureFlagAdapterProvider`), not
 * `@repo/analytics`.
 *
 * Gated on a mounted flag to avoid a hydration mismatch — flag state resolves
 * client-side, so the server/first paint renders nothing.
 */
export function FeatureFlagged({ flag, children }: FeatureFlaggedProps) {
  const [mounted, setMounted] = useState(false);
  const flagEnabled = useFeatureFlagEnabled(flag);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return flagEnabled ? children : null;
}
