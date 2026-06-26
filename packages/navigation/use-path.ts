"use client";

import { useNavigationAdapter } from "./provider";

/**
 * Current path for the surface. Replaces direct `usePathname()` usage from
 * next/navigation in shared/feature code.
 */
export function usePath(): string {
  return useNavigationAdapter().usePathValue();
}
