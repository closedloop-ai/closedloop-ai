"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { notFound } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";

type FeatureFlagGateProps = {
  readonly flag: string;
  readonly children: ReactNode;
};

/**
 * Renders children only when the given PostHog flag is enabled; otherwise
 * triggers a 404 so direct URL access to a flagged-off route is not reachable.
 * The mount guard avoids a hydration mismatch while the flag resolves client-side.
 */
export function FeatureFlagGate({ flag, children }: FeatureFlagGateProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const result = useFeatureFlag(flag);

  if (!mounted) {
    return null;
  }

  if (result?.enabled !== true) {
    notFound();
  }

  return <>{children}</>;
}
