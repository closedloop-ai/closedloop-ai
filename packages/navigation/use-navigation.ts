"use client";

import type { NavigationActions } from "./navigation-adapter";
import { useNavigationAdapter } from "./provider";

/**
 * Imperative navigation for the current surface. Replaces direct
 * `useRouter()` usage from next/navigation in shared/feature code.
 */
export function useNavigation(): NavigationActions {
  return useNavigationAdapter().useNavigationActions();
}
