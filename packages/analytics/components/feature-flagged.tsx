"use client";

import { useFeatureFlag } from "../client";

type FeatureFlaggedProps = {
  flag: string;
  enabled?: boolean;
  children: React.ReactNode;
};

export function FeatureFlagged({
  flag,
  enabled,
  children,
}: FeatureFlaggedProps) {
  const result = useFeatureFlag(flag);
  const resolvedEnabled = enabled ?? result?.enabled;

  return resolvedEnabled ? children : null;
}
