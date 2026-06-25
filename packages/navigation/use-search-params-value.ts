"use client";

import type { ReadonlySearchParams } from "./navigation-adapter";
import { useNavigationAdapter } from "./provider";

/**
 * Read-only snapshot of the current search params. Replaces direct
 * `useSearchParams()` usage from next/navigation in shared/feature code.
 *
 * Treat the returned value as immutable; writes go through `useNavigation()`.
 */
export function useSearchParamsValue(): ReadonlySearchParams {
  return useNavigationAdapter().useSearchParamsSnapshot();
}
