"use client";

import { useFeatureFlagAdapterOptional } from "../../feature-flags/provider";

/**
 * ISS-12048: a flag's real value for the overlay, through the shell's adapter,
 * or `undefined` when the adapter cannot say. The adapter identity is stable
 * for a mounted tree, so the selected implementation cannot change between
 * renders (the same reasoning as `useFeatureFlagResolved`).
 */
export function useFeatureFlagProductionValue(
  key: string
): boolean | undefined {
  const adapter = useFeatureFlagAdapterOptional();
  const useProductionValue =
    adapter.useFeatureFlagProductionValue ?? unknownProductionValue;
  return useProductionValue(key);
}

function unknownProductionValue(): boolean | undefined {
  return undefined;
}
