"use client";

import { useEffect, useState } from "react";
import { useFeatureFlag } from "../client";

type FeatureFlaggedProps = {
  flag: string;
  enabled?: boolean;
  children: React.ReactNode;
  fallback?: React.ReactNode;
};

export function FeatureFlagged({
  flag,
  enabled,
  children,
  fallback = null,
}: FeatureFlaggedProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const result = useFeatureFlag(flag);
  const resolvedEnabled = enabled ?? result?.enabled;

  if (!mounted) {
    return null;
  }

  return resolvedEnabled ? children : fallback;
}
