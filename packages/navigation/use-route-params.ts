"use client";

import type { RouteParams } from "./navigation-adapter";
import { useNavigationAdapter } from "./provider";

/**
 * Dynamic route params for the current view. Replaces direct `useParams()`
 * usage from next/navigation in shared/feature code.
 */
export function useRouteParams(): RouteParams {
  return useNavigationAdapter().useRouteParamsValue();
}
